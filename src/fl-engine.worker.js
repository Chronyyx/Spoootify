/*
 * Fluid Lyrics — timing engine (runs in a dedicated Worker).
 *
 * Everything that costs CPU lives here so the UI thread never parses JSON,
 * syllabifies text or runs alignment while the user is clicking around:
 *   1. fetch Spotify line-synced lyrics, LRCLIB (for true word sync) and the
 *      track's audio analysis, all in parallel
 *   2. if real word/syllable timestamps exist, use them
 *   3. otherwise synthesize syllable timing from line timing with a prosody
 *      model, then snap syllable onsets to detected audio attacks / tatums
 *   4. post back a compact, render-ready timeline
 */
'use strict';

const CACHE_MAX = 40;
const cache = new Map(); // trackId -> Promise<result>

const MIN_SYL_MS = 70;
const UNIT_MS = 205; // nominal sung syllable length used by the prosody model
const GAP_MIN_MS = 3800; // instrumental breaks longer than this get the breathing dots

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load' || m.type === 'prefetch') {
    const p = load(m.track, m.token, m.opts || {});
    if (m.type === 'load') {
      p.then(
        (data) => self.postMessage({ type: 'result', reqId: m.reqId, trackId: m.track.id, data }),
        (err) => self.postMessage({ type: 'result', reqId: m.reqId, trackId: m.track.id, data: { kind: 'none', error: String(err && err.message || err) } }),
      );
    }
  } else if (m.type === 'evict') {
    cache.delete(m.trackId);
  }
};

function load(track, token, opts) {
  const key = track.id + (opts.lrclib === false ? ':nolrc' : '');
  let p = cache.get(key);
  if (p) {
    cache.delete(key);
    cache.set(key, p); // LRU bump
    return p;
  }
  p = build(track, token, opts).catch((err) => {
    cache.delete(key); // don't cache failures
    throw err;
  });
  cache.set(key, p);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

// ───────────────────────────── network ─────────────────────────────

async function getJSON(url, headers, timeout = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function spotifyLyrics(track, token) {
  if (track.isLocal || !token) return Promise.resolve(null);
  return getJSON(
    `https://spclient.wg.spotify.com/color-lyrics/v2/track/${track.id}?format=json&vocalRemoval=false&market=from_token`,
    { authorization: 'Bearer ' + token, 'app-platform': 'WebPlayer', accept: 'application/json' },
  );
}

function lrclib(track) {
  const q = new URLSearchParams({
    track_name: track.name,
    artist_name: track.artists[0] || '',
    album_name: track.album || '',
    duration: String(Math.round(track.durationMs / 1000)),
  });
  const H = { 'Lrclib-Client': 'FluidLyrics/1.0' };
  // the exact lookup misses when Spotify's album/duration differ slightly from LRCLIB's entry
  // (and it 503s now and then), so fall back to a search ranked by artist, sync and duration
  return getJSON('https://lrclib.net/api/get?' + q, H, 6000).then(async (hit) => {
    if (hit && (hit.syncedLyrics || hit.plainLyrics || hit.instrumental)) return hit;
    const list = await getJSON('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: track.name, artist_name: track.artists[0] || '' }), H, 6000);
    if (!Array.isArray(list)) return hit;
    const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
    const name = norm(track.name), artist = norm(track.artists[0]), dur = track.durationMs / 1000;
    let best = null, bestScore = -1;
    for (const c of list) {
      if (norm(c.trackName) !== name || !norm(c.artistName).includes(artist)) continue;
      const off = Math.abs((c.duration || 0) - dur);
      if (off > 4) continue;
      const score = (c.syncedLyrics ? 10 : c.plainLyrics ? 5 : 0) - off;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return best || hit;
  });
}

// NetEase Cloud Music sends no CORS headers, so it is queried through the Spoootify helper's
// local relay (tools/lyrics-proxy.mjs). No helper running → connection refused → null, fast.
function netease(track) {
  return getJSON('http://127.0.0.1:47321/v1/netease?' + new URLSearchParams({
    track: track.name,
    artist: track.artists[0] || '',
    duration: String(Math.round(track.durationMs / 1000)),
  }), {}, 12000);
}

// last resort: plain (unsynced) lyrics
async function lyricsOvh(track) {
  if (!track.artists[0]) return null;
  const j = await getJSON(`https://api.lyrics.ovh/v1/${encodeURIComponent(track.artists[0])}/${encodeURIComponent(track.name)}`, {}, 7000);
  if (!j || typeof j.lyrics !== 'string') return null;
  // the API sometimes prefixes a French "Paroles de la chanson … par …" header line
  const text = j.lyrics.replace(/\r\n?/g, '\n').replace(/^Paroles de la chanson .*\n/, '').trim();
  return text || null;
}

async function audioAnalysis(track, token) {
  if (track.isLocal || !token) return null;
  const j = await getJSON(
    `https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${track.id}?format=json`,
    { authorization: 'Bearer ' + token },
    12000,
  );
  if (!j || !Array.isArray(j.segments)) return null;
  // Reduce ~400 KB of JSON to two flat typed arrays of onset candidates.
  const segs = j.segments;
  const times = new Float64Array(segs.length + (j.tatums ? j.tatums.length : 0));
  const strength = new Float32Array(times.length);
  let n = 0;
  for (const s of segs) {
    const attack = (s.loudness_max - s.loudness_start) / 14; // dB rise over the attack
    const loud = (s.loudness_max + 30) / 30; // louder segments are likelier to carry the lead vocal
    const v = clamp(attack, 0, 1) * 0.6 + clamp(s.confidence || 0, 0, 1) * 0.25 + clamp(loud, 0, 1) * 0.15;
    if (v < 0.2) continue;
    times[n] = s.start * 1000;
    strength[n++] = v;
  }
  if (j.tatums) {
    for (const t of j.tatums) {
      times[n] = t.start * 1000;
      strength[n++] = 0.28 * clamp(t.confidence || 0.5, 0.3, 1);
    }
  }
  // sort by time (segments and tatums are each sorted; merge via index sort)
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => times[a] - times[b]);
  const T = new Float64Array(n), S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    T[i] = times[idx[i]];
    S[i] = strength[idx[i]];
  }
  return { t: T, s: S };
}

// ───────────────────────────── build ─────────────────────────────

async function build(track, token, opts) {
  const wantLrc = opts.lrclib !== false;
  const [sp, lrc, onsets] = await Promise.all([
    spotifyLyrics(track, token),
    wantLrc ? lrclib(track) : null,
    audioAnalysis(track, token),
  ]);

  // 1) true word-level timing from LRCLIB enhanced LRC
  if (lrc && typeof lrc.syncedLyrics === 'string' && /<\d+:\d+(?:\.\d+)?>/.test(lrc.syncedLyrics)) {
    const lines = parseEnhancedLRC(lrc.syncedLyrics);
    if (lines.length) return finalize(lines, track, 'LRCLIB', 'word');
  }

  const lf = lrc && typeof lrc.lyricsfile === 'string' ? parseLyricsfile(lrc.lyricsfile) : null;
  if (lf && lf.some((l) => l.words.length && l.words[0].e > 0)) {
    const lines = lf.map((l) => ({
      start: l.start, text: l.text,
      words: l.words.filter((w) => w.text.trim()).map((w) => toWord({ syl: [{ text: w.text.trim(), s: w.s, e: w.e || w.s + 250 }] })),
    }));
    if (lines.some((l) => l.words.length)) return finalize(lines, track, 'LRCLIB', 'word');
  }

  // 2) Spotify lyrics (line synced, occasionally syllable synced)
  const L = sp && sp.lyrics;
  let spStatic = null; // Spotify's unsynced text: used only if no other source has timing
  if (L && Array.isArray(L.lines) && L.lines.length) {
    const provider = 'Spotify' + (L.providerDisplayName ? ' · ' + L.providerDisplayName : '');
    if (L.syncType === 'UNSYNCED') {
      spStatic = { kind: 'static', source: provider, sync: 'static', items: L.lines.map((l) => ({ t: 'line', text: l.words || '' })) };
    }
  }
  if (L && !spStatic && Array.isArray(L.lines) && L.lines.length) {
    const provider = 'Spotify' + (L.providerDisplayName ? ' · ' + L.providerDisplayName : '');
    const raw = L.lines.map((l) => ({
      start: +l.startTimeMs,
      end: +l.endTimeMs || 0,
      text: (l.words || '').trim(),
      syllables: Array.isArray(l.syllables) ? l.syllables : [],
    }));
    const hasSyl = raw.some((l) => l.syllables.length);
    if (hasSyl) {
      const lines = raw.map(spotifySyllables);
      return finalize(lines, track, provider, 'syllable');
    }
    if (lf) attachEnds(raw, lf);
    return finalize(synthesize(raw, track, onsets), track, provider, onsets ? 'smart+audio' : 'smart');
  }

  // 3) LRCLIB line synced
  if (lrc && typeof lrc.syncedLyrics === 'string' && lrc.syncedLyrics.trim()) {
    const raw = parseLRC(lrc.syncedLyrics);
    if (lf) attachEnds(raw, lf);
    if (raw.length) return finalize(synthesize(raw, track, onsets), track, 'LRCLIB', onsets ? 'smart+audio' : 'smart');
  }

  // 4) NetEase Cloud Music via the helper's relay — asked only when nobody above had timing
  const ne = wantLrc ? await netease(track) : null;
  if (ne && typeof ne.yrc === 'string' && ne.yrc.trim()) {
    const lines = parseYRC(ne.yrc);
    if (lines.some((l) => l.words.length)) return finalize(lines, track, 'NetEase', 'word');
  }
  if (ne && typeof ne.lrc === 'string') {
    const raw = dropCredits(parseLRC(ne.lrc));
    if (raw.some((r) => r.start > 0) && raw.filter((r) => r.text).length >= 3) {
      return finalize(synthesize(raw, track, onsets), track, 'NetEase', onsets ? 'smart+audio' : 'smart');
    }
  }

  // 5) unsynced text, best source first
  const plain = (src, text) => ({ kind: 'static', source: src, sync: 'static', items: text.split('\n').map((t) => ({ t: 'line', text: t })) });
  if (spStatic) return spStatic;
  if (lrc && lrc.plainLyrics) return plain('LRCLIB', lrc.plainLyrics);
  if (lrc && lrc.instrumental) return { kind: 'none', reason: 'instrumental' };
  const ovh = wantLrc ? await lyricsOvh(track) : null;
  if (ovh) return plain('lyrics.ovh', ovh);
  return { kind: 'none', reason: 'missing' };
}

// ───────────────────────────── parsers ─────────────────────────────

const TS = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
const ts2ms = (m, s) => (+m * 60 + +s) * 1000;

function parseLRC(src) {
  const out = [];
  for (const row of src.split(/\r?\n/)) {
    TS.lastIndex = 0;
    const stamps = [];
    let m, last = 0;
    while ((m = TS.exec(row))) {
      stamps.push(ts2ms(m[1], m[2]));
      last = TS.lastIndex;
    }
    if (!stamps.length) continue;
    const text = row.slice(last).trim();
    for (const st of stamps) out.push({ start: st, end: 0, text });
  }
  return out.sort((a, b) => a.start - b.start);
}

// NetEase prefixes lyrics with credit lines ("作词 : …", "Producer : …") — not sung, drop them
const CREDIT = /^\s*(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s/]{1,12}|(?:lyrics|lyricist|written|writer|composer|composed|producer|produced|arranger|arranged|mix(?:ed|ing)?|master(?:ed|ing)?|engineer|recorded|vocals?|music|words)(?:\s+by)?)\s*[:：]/iu;
function dropCredits(raw) {
  return raw.filter((r) => !CREDIT.test(r.text));
}

// NetEase word-synced "yrc":  [lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)text(…)text…
// (lines starting with "{" are JSON credit blobs)
function parseYRC(src) {
  const lines = [];
  for (const row of src.split(/\r?\n/)) {
    const m = row.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) continue;
    const parts = m[3].split(/\((\d+),(\d+),\d+\)/); // ['', s, d, text, s, d, text, …]
    const words = [];
    let cur = null;
    for (let i = 1; i + 2 < parts.length; i += 3) {
      const s = +parts[i], e = s + Math.max(+parts[i + 1], MIN_SYL_MS), piece = parts[i + 2];
      const t = piece.trim();
      if (!t) { cur = null; continue; }
      // English yrc is one chunk per word, but its spaces are unreliable ("how(…)to " →
      // "howto"), so every chunk starts a word — except bare punctuation, and CJK characters
      // following CJK (those are per-character syllables of one unspaced run)
      const prev = cur && cur.syl[cur.syl.length - 1].text;
      const glue = cur && !/^\s/.test(piece) &&
        (!/[\p{L}\p{N}]/u.test(t) || (CJK.test(t) && CJK.test(prev.slice(-1))));
      if (!glue) {
        cur = { syl: [] };
        words.push(cur);
      }
      cur.syl.push({ text: t, s, e });
      if (/\s$/.test(piece)) cur = null; // trailing space closes the word
    }
    const text = words.map((w) => w.syl.map((x) => x.text).join('')).join(' ');
    if (CREDIT.test(text)) continue;
    lines.push({ start: words.length ? words[0].syl[0].s : +m[1], text, words: words.map(toWord) });
  }
  return lines.sort((a, b) => a.start - b.start);
}

/**
 * LRCLIB "lyricsfile" (YAML subset): lines with start_ms / end_ms, optionally nested words.
 * Tiny indentation-aware reader for exactly that shape — no YAML library needed.
 */
function parseLyricsfile(src) {
  const lines = [];
  let cur = null, curWord = null, lineIndent = -1;
  const unq = (v) => {
    v = v.trim();
    if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
    return v;
  };
  let inLines = false;
  for (const row of src.split(/\r?\n/)) {
    if (/^lines:\s*$/.test(row)) { inLines = true; continue; }
    if (!inLines) continue;
    let m = row.match(/^(\s*)- text: ?(.*)$/);
    if (m) {
      const ind = m[1].length;
      if (lineIndent < 0) lineIndent = ind;
      if (ind === lineIndent) {
        cur = { text: unq(m[2]), start: 0, end: 0, words: [] };
        curWord = null;
        lines.push(cur);
      } else if (cur) {
        curWord = { text: unq(m[2]), s: 0, e: 0 };
        cur.words.push(curWord);
      }
      continue;
    }
    m = row.match(/^(\s*)(start_ms|end_ms): (\d+)/);
    if (m && cur) {
      const ind = m[1].length;
      const target = curWord && ind > lineIndent + 2 ? curWord : cur;
      if (target === cur) cur[m[2] === 'start_ms' ? 'start' : 'end'] = +m[3];
      else curWord[m[2] === 'start_ms' ? 's' : 'e'] = +m[3];
    } else if (/^\S/.test(row)) inLines = false;
  }
  return lines;
}

const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Give Spotify's start-only lines the true vocal end time from a matching lyricsfile line. */
function attachEnds(raw, lf) {
  let j = 0;
  for (const r of raw) {
    const nt = norm(r.text);
    if (!nt) continue;
    for (let k = j; k < lf.length && lf[k].start <= r.start + 2500; k++) {
      const nextStart = lf[k + 1] ? lf[k + 1].start : Infinity;
      // end_ms only tells us something when it stops clearly before the next line
      if (Math.abs(lf[k].start - r.start) < 1500 && lf[k].end > lf[k].start && lf[k].end < nextStart - 150 && norm(lf[k].text) === nt) {
        r.end = lf[k].end + (r.start - lf[k].start); // keep Spotify's start, transfer the duration
        r.endExact = true;
        j = k + 1;
        break;
      }
    }
  }
}

// [mm:ss.xx] <mm:ss.xx> word <mm:ss.xx> wo<mm:ss.xx>rd <mm:ss.xx>
function parseEnhancedLRC(src) {
  const lines = [];
  const raw = parseLRC(src.replace(/<(\d+:\d+(?:\.\d+)?)>/g, '\u0001$1\u0002'));
  for (const r of raw) {
    const parts = r.text.split(/\u0001(\d+):(\d+(?:\.\d+)?)\u0002/);
    // parts: [lead, m, s, text, m, s, text, ...]
    const chunks = [];
    if (parts[0].trim()) chunks.push({ s: r.start, text: parts[0] });
    for (let i = 1; i + 2 < parts.length + 1; i += 3) {
      const t = ts2ms(parts[i], parts[i + 1]);
      const text = parts[i + 2] ?? '';
      chunks.push({ s: t, text });
    }
    // chunk i ends at chunk i+1's start; empty trailing chunk only carries an end time
    const words = [];
    let cur = null;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const e = i + 1 < chunks.length ? chunks[i + 1].s : c.s + 400;
      if (!c.text) continue;
      const lead = /^\s/.test(c.text), trail = /\s$/.test(c.text);
      const pieces = c.text.trim().split(/\s+/).filter(Boolean);
      // a chunk with interior spaces carries several words: share its time span by length
      const total = pieces.reduce((a, p) => a + p.length, 0) || 1;
      let t0 = c.s;
      pieces.forEach((p, k) => {
        const t1 = k === pieces.length - 1 ? e : t0 + ((e - c.s) * p.length) / total;
        if (cur && !lead && k === 0) {
          cur.syl.push({ text: p, s: t0, e: t1 }); // glued syllable of the previous word
        } else {
          cur = { syl: [{ text: p, s: t0, e: t1 }] };
          words.push(cur);
        }
        t0 = t1;
      });
      if (trail) cur = null;
    }
    if (!words.length) {
      lines.push({ start: r.start, text: '', words: [] });
      continue;
    }
    lines.push({
      start: words[0].syl[0].s,
      text: words.map((w) => w.syl.map((s) => s.text).join('')).join(' '),
      words: words.map(toWord),
    });
  }
  return lines;
}

function spotifySyllables(l) {
  // Defensive: Spotify's syllable payload is undocumented. Accept {startTimeMs, numChars|charCount}.
  const text = l.text;
  const syl = l.syllables;
  let pos = 0;
  const pieces = syl.map((s, i) => {
    const n = +(s.numChars ?? s.charCount ?? s.length ?? 0) || 0;
    const st = +(s.startTimeMs ?? s.start ?? 0);
    const t = n ? text.slice(pos, pos + n) : '';
    pos += n;
    return { text: t, s: st, e: +(syl[i + 1]?.startTimeMs ?? s.endTimeMs ?? st + 300) };
  });
  if (!pieces.length || pos === 0) return { start: l.start, text, words: null };
  const words = [];
  let cur = null;
  for (const p of pieces) {
    const lead = /^\s/.test(p.text);
    const t = p.text.trim();
    if (!t) { cur = null; continue; }
    if (!cur || lead) {
      cur = { syl: [] };
      words.push(cur);
    }
    cur.syl.push({ text: t, s: p.s, e: p.e });
    if (/\s$/.test(p.text)) cur = null;
  }
  return { start: l.start, text, words: words.map(toWord) };
}

function toWord(w) {
  const text = w.syl.map((s) => s.text).join('');
  const len = text.length || 1;
  let acc = 0;
  return {
    text,
    s: w.syl[0].s,
    e: w.syl[w.syl.length - 1].e,
    syl: w.syl.map((s) => {
      acc += s.text.length;
      return { s: s.s, e: s.e, c: acc / len };
    }),
  };
}

// ───────────────────────── word-timing synthesis ─────────────────────────

const VOWELS = 'aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ';
const isVowel = (ch) => VOWELS.includes(ch.toLowerCase());
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
const FUNCTION_WORDS = new Set(
  'a an the to of and in on at is it i my me you your we our but or so for as be by if do with that this from up oh uh yeah ah'.split(' '),
);
const LONG_NUCLEUS = /(ee|oo|ea|ai|ay|oa|ow|ou|igh|ie|oy|oi|aw|ue|ei|ey)/i;

/** Split a word into syllable strings whose concatenation equals the word. */
function syllabify(word) {
  if (CJK.test(word)) return Array.from(word); // one char ≈ one sung syllable (kana / hanzi / hangul block)
  const chars = Array.from(word);
  const lower = word.toLowerCase();
  // syllable starts: a consonant run before a vowel group splits as V|CV or VC|CV
  const starts = [0];
  let i = 0;
  // skip leading non-vowels
  while (i < chars.length && !isVowel(chars[i])) i++;
  while (i < chars.length) {
    while (i < chars.length && isVowel(chars[i])) i++; // vowel group
    const cs = i;
    while (i < chars.length && !isVowel(chars[i])) i++; // consonant run
    if (i >= chars.length) break; // trailing consonants belong to last syllable
    const run = i - cs;
    const cut = run <= 1 ? cs : cs + Math.floor(run / 2);
    if (cut > starts[starts.length - 1]) starts.push(cut);
  }
  let syl = starts.map((s, k) => chars.slice(s, starts[k + 1] ?? chars.length).join(''));
  // silent final "e" (make, believe, alive): fold "Ce"/"Ces"/"Ced" back into the previous syllable
  if (syl.length > 1) {
    const last = syl[syl.length - 1].toLowerCase().replace(/[^a-z]/g, '');
    // fold only genuinely silent endings: make, believe · makes (not colleges) · loved (not wanted)
    const silent =
      /^[^aeiouy]e$/.test(last) && last !== 'le' ||
      /^[^aeiouyszxcg]es$/.test(last) ||
      /^[^aeiouytd]ed$/.test(last);
    if (silent) syl[syl.length - 2] += syl.pop();
  }
  return syl.filter(Boolean);
}

function sylWeight(s, isFn, multi) {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (!letters) return 0.15;
  let w = 1;
  if (LONG_NUCLEUS.test(letters) || /[aeiouy]$/i.test(letters)) w += 0.35;
  const cons = letters.replace(new RegExp('[' + VOWELS + ']', 'gi'), '').length;
  w += 0.1 * Math.max(0, cons - 2);
  if (isFn && !multi) w *= 0.85;
  return w;
}

function pauseAfter(token) {
  if (/[.!?…]["'”’)]*$/.test(token)) return 0.9;
  if (/[,;:]["'”’)]*$/.test(token)) return 0.55;
  if (/[—–-]$/.test(token)) return 0.45;
  return 0;
}

/** Prosody model for one line → per-syllable weights in abstract "units". */
function prosody(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const model = tokens.map((tok, wi) => {
    const core = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const fn = FUNCTION_WORDS.has(core.toLowerCase());
    const syl = syllabify(tok);
    const weights = syl.map((s) => sylWeight(s, fn, syl.length > 1));
    return { tok, syl, weights, pause: wi < tokens.length - 1 ? pauseAfter(tok) : 0 };
  });
  // phrase-final lengthening: singers stretch the last syllable of a line
  const lastW = model[model.length - 1];
  lastW.weights[lastW.weights.length - 1] *= 2.0;
  let units = 0;
  for (const m of model) units += m.weights.reduce((x, y) => x + y, 0) + m.pause;
  return { model, units };
}

// Song-level tempo adaptation: how long this song typically gives a line relative to its
// syllable load. Slow songs (gospel, ballads) sing through most of each slot; fast ones leave
// gaps. The per-line stretch limit follows the song instead of a fixed constant.
const STRETCH_MIN = 1.3, STRETCH_MAX = 4.0, SONG_K = 0.9; // fitted on JamendoLyrics; cap verified on slow gospel

/** Lay a token sequence out from `start`, using `base` ms for its syllables plus `hold` on the last one. */
function layOut(text, start, base, hold) {
  const { model, units } = prosody(text);
  const unit = base / units;
  let t = start;
  const words = [];
  model.forEach((m, wi) => {
    const syl = [];
    const len = m.syl.reduce((a, s) => a + s.length, 0) || 1;
    let acc = 0;
    m.syl.forEach((s, si) => {
      let d = m.weights[si] * unit;
      if (wi === model.length - 1 && si === m.syl.length - 1) d += hold;
      acc += s.length;
      syl.push({ s: t, e: t + d, c: acc / len, d });
      t += d;
    });
    words.push({ text: m.tok, s: syl[0].s, e: t, syl, pauseMs: m.pause * unit });
    t += m.pause * unit;
  });
  return { words, end: t };
}

/**
 * Split a line into the lead vocal and its ad-libs. Text inside (...) is sung by another voice
 * at the same time, so it must not wait for — or hold up — the main words.
 * Returns { main: [token], groups: [{ after: <main token count before it>, tokens: [token] }], order }.
 */
function splitAdlibs(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const main = [], groups = [], order = [];
  let depth = 0, cur = null;
  for (const tok of tokens) {
    const opens = (tok.match(/\(/g) || []).length;
    const closes = (tok.match(/\)/g) || []).length;
    const inside = depth > 0 || opens > 0;
    if (inside) {
      if (!cur) { cur = { after: main.length, tokens: [] }; groups.push(cur); }
      order.push({ g: groups.length - 1, i: cur.tokens.length });
      cur.tokens.push(tok);
    } else {
      order.push({ m: main.length });
      main.push(tok);
    }
    depth = Math.max(0, depth + opens - closes);
    if (depth === 0) cur = null;
  }
  return { main, groups, order };
}

function synthesize(raw, track, onsets) {
  const slotOf = (k) => {
    const r = raw[k], next = raw[k + 1];
    return Math.max(250, (r.end > r.start ? r.end : next ? next.start : Math.min(track.durationMs, r.start + 6000)) - r.start);
  };
  const isVocal = (t) => t && !/^[♪♫\s]*$/.test(t);
  const leadText = (t) => {
    const { main } = splitAdlibs(t);
    return main.length ? main.join(' ') : t; // all-adlib line: it *is* the lead
  };
  const ratios = [];
  for (let k = 0; k < raw.length; k++) {
    if (!isVocal(raw[k].text) || raw[k].endExact) continue;
    ratios.push((slotOf(k) * 0.97) / (prosody(leadText(raw[k].text)).units * UNIT_MS));
  }
  ratios.sort((x, y) => x - y);
  const songRate = ratios.length ? ratios[ratios.length >> 1] : 1;
  const stretch = Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, songRate * SONG_K));

  const lines = [];
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k];
    const text = r.text;
    if (!isVocal(text)) {
      lines.push({ start: r.start, text: '', words: [] });
      continue;
    }
    const slot = slotOf(k);
    const slotEnd = r.start + slot;
    const split = splitAdlibs(text);
    const parallel = split.main.length > 0 && split.groups.length > 0;
    const lead = parallel ? split.main.join(' ') : text;

    // ── lead vocal: owns the whole slot ──
    // Pacing constants are fitted to human word annotations (JamendoLyrics: tuned on 39 songs,
    // validated on 39 others). Vocals use ~97 % of a line's slot; a line may stretch the nominal
    // syllable rate as far as this song's own typical pace allows; a little leftover becomes a held note.
    const natural = prosody(lead).units * UNIT_MS;
    const budget = r.endExact ? slot * 0.98 : slot * 0.97;
    const base = r.endExact ? budget : Math.min(budget, Math.max(natural, Math.min(budget * 0.92, natural * stretch)));
    const hold = Math.min(Math.max(0, budget - base) * 0.15, 800);
    const main = layOut(lead, r.start, base, hold);
    if (onsets) alignToAudio(main.words, onsets, r.start, Math.min(slotEnd, main.end + 400));
    applyLead(main.words, r.start);
    if (!parallel) {
      lines.push({ start: r.start, text, words: main.words });
      continue;
    }

    // ── ad-libs: a second voice, sung over the lead ──
    // Each group enters right after the lead word it follows (or with the line if it comes
    // first) and runs at its own natural pace, independent of the lead's timing.
    const groupWords = split.groups.map((g) => {
      const gText = g.tokens.join(' ');
      // ad-libs keep a natural singing pace — never squeezed into leftover room (that read as
      // "speeding up and late"). They answer the lead word they follow: enter while it is
      // being sung (not after a held-note tail); if the line can't fit them, enter earlier instead.
      const natural = prosody(gText).units * UNIT_MS;
      const prev = g.after > 0 ? main.words[g.after - 1] : null;
      // mid-line: enter as the preceding lead word ends. After the line's last (held) word:
      // enter when that word's natural length is over — the held tail doesn't delay the ad-lib.
      let anchor = r.start;
      if (prev) {
        const isLast = prev === main.words[main.words.length - 1];
        anchor = isLast ? Math.min(prev.e, prev.s + Math.max(250, prev.syl.length * UNIT_MS * 1.2)) : prev.e;
      }
      // fit: at most a barely-audible 1.3x speed-up; only beyond that, enter earlier
      const room = Math.max(250, slotEnd - anchor);
      const dur = Math.max(natural / 1.3, Math.min(natural, room));
      anchor = Math.max(r.start, Math.min(anchor, slotEnd - dur));
      return layOut(gText, anchor, dur, 0).words;
    });
    // emit in the lyric's original order (finalize() detects ad-libs by their parentheses)
    const words = split.order.map((o) => (o.m !== undefined ? main.words[o.m] : groupWords[o.g][o.i]));
    lines.push({ start: r.start, text, words });
  }
  return lines;
}


// Synthesized timing is never exact; a late fill reads as lag while a slightly early one reads
// as "leading the voice" (Apple's feel). Fitted on JamendoLyrics with lateness penalised 2x:
// 120 ms cuts words >300 ms late from 16.8 % to 12.0 % (held-out songs).
const LEAD_MS = 120;
function applyLead(words, lineStart) {
  const first = words[0].syl[0];
  for (const w of words) {
    for (const y of w.syl) {
      if (y !== first) y.s = Math.max(lineStart + 40, y.s - LEAD_MS);
      y.e = Math.max(y.s + 40, y.e - LEAD_MS);
    }
    w.s = w.syl[0].s;
    w.e = w.syl[w.syl.length - 1].e;
  }
}

/**
 * Refine estimated syllable onsets with audio attacks, without wrecking the pacing.
 *  1. pick *anchors*: syllables with a strong, unambiguous attack close to the estimate
 *  2. reject anchors that would make the local tempo implausible (outside 0.65×–1.5×)
 *  3. place every other syllable by linear interpolation between neighbouring anchors,
 *     in proportion to the prosody estimate → speed is piecewise-constant and smooth,
 *     never a jerky per-syllable stretch.
 */
function alignToAudio(words, onsets, lineStart, lineEnd) {
  const { t: T, s: S } = onsets;
  const flat = [];
  for (const w of words) for (const s of w.syl) flat.push({ w, s, est: s.s });
  if (flat.length < 3) return;
  const lo0 = lowerBound(T, lineStart + 60);
  const hi = lowerBound(T, lineEnd);
  if (hi - lo0 < 1) return;

  const endEst = flat[flat.length - 1].s.e;
  const anchors = [{ i: 0, t: flat[0].est }];
  let lo = lo0;
  for (let i = 1; i < flat.length; i++) {
    const est = flat[i].est;
    const tol = 0.35 * Math.min(flat[i - 1].s.d, flat[i].s.d) + 20;
    let best = -1, bestScore = 0.45;
    for (let j = lowerBound(T, est - tol, lo, hi); j < hi && T[j] <= est + tol; j++) {
      const score = S[j] * (1 - Math.abs(T[j] - est) / tol);
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best < 0) continue;
    const a = anchors[anchors.length - 1];
    const t = est + (T[best] - est) * 0.7;
    const ratio = (t - a.t) / (est - flat[a.i].est || 1);
    if (ratio < 0.65 || ratio > 1.5 || t - a.t < MIN_SYL_MS * (i - a.i)) continue;
    anchors.push({ i, t });
    lo = best + 1;
  }
  // closing anchor: keep the estimated vocal end unless the last anchor pushed past it
  const last = anchors[anchors.length - 1];
  const endT = Math.max(endEst, last.t + MIN_SYL_MS * (flat.length - last.i));
  anchors.push({ i: flat.length, t: endT });
  const estAt = (i) => (i < flat.length ? flat[i].est : endEst);

  for (let k = 0; k + 1 < anchors.length; k++) {
    const A = anchors[k], B = anchors[k + 1];
    const e0 = estAt(A.i), e1 = estAt(B.i);
    const r = (B.t - A.t) / ((e1 - e0) || 1);
    for (let i = A.i; i < B.i; i++) {
      flat[i].s.s = A.t + (flat[i].est - e0) * r;
      flat[i].s.d *= r;
    }
  }
  // ends: a syllable runs into the next one unless its word is followed by a pause
  for (let i = 0; i < flat.length; i++) {
    const cur = flat[i].s;
    const nx = flat[i + 1];
    if (nx) {
      const pause = nx.w !== flat[i].w && flat[i].w.pauseMs > 0;
      cur.e = pause ? Math.min(nx.s.s, cur.s + Math.max(MIN_SYL_MS, cur.d)) : nx.s.s;
    } else {
      cur.e = Math.max(cur.s + MIN_SYL_MS, endT);
    }
  }
  for (const w of words) {
    w.s = w.syl[0].s;
    w.e = w.syl[w.syl.length - 1].e;
  }
}

function lowerBound(arr, x, lo = 0, hi = arr.length) {
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// ───────────────────────────── finalize ─────────────────────────────

/**
 * Turn timed lines into the renderer's item list:
 *  { t:'line', s, e (active-until), vEnd (vocal end), bgFrom, words:[{text,s,e,syl:[{s,e,c}],emph,bg}] }
 *  { t:'gap', s, e }  ← instrumental break shown as Apple-style breathing dots
 */
function finalize(lines, track, source, sync) {
  const items = [];
  const dur = track.durationMs || 0;
  const vocal = lines.filter((l) => l.words && l.words.length);
  if (!vocal.length) return { kind: 'none', reason: 'missing' };

  if (vocal[0].words[0].s >= GAP_MIN_MS) items.push({ t: 'gap', s: 0, e: vocal[0].words[0].s - 220 });

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.words || !l.words.length) continue;
    // background vocals: anything inside (...) renders as a smaller secondary line
    let depth = 0;
    const words = l.words.map((w) => {
      const opens = (w.text.match(/\(/g) || []).length;
      const closes = (w.text.match(/\)/g) || []).length;
      const bg = depth > 0 || opens > 0;
      depth = Math.max(0, depth + opens - closes);
      const dur = w.e - w.s;
      const letters = w.text.replace(/[^\p{L}]/gu, '').length;
      return {
        text: w.text.replace(/[()]/g, ''),
        s: round(w.s),
        e: round(Math.max(w.e, w.s + MIN_SYL_MS)),
        syl: w.syl.map((y) => ({ s: round(y.s), e: round(Math.max(y.e, y.s + 30)), c: +y.c.toFixed(4) })),
        emph: dur >= 1000 && letters >= 2 && letters <= 12 && dur / letters >= 140 ? 1 : 0,
        bg: bg ? 1 : 0,
      };
    }).filter((w) => w.text);
    if (!words.length) continue;
    const vEnd = Math.max(...words.map((w) => w.e));
    // next line with words
    let nx = null;
    for (let j = i + 1; j < lines.length; j++) if (lines[j].words && lines[j].words.length) { nx = lines[j]; break; }
    const nextStart = nx ? nx.words[0].s : dur || vEnd + 4000;
    const gap = nextStart - vEnd;
    const allBg = words.every((w) => w.bg);
    if (allBg) words.forEach((w) => (w.bg = 0));
    items.push({ t: 'line', s: round(words[0].s), e: round(gap >= GAP_MIN_MS ? vEnd + 350 : nextStart), vEnd: round(vEnd), words, side: allBg ? 'bg' : '' });
    if (gap >= GAP_MIN_MS && nx) items.push({ t: 'gap', s: round(vEnd + 450), e: round(nextStart - 220) });
  }
  return { kind: 'synced', source, sync, items };
}

const round = (x) => Math.round(x);
function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}
