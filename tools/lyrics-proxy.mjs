#!/usr/bin/env node
/*
 * Spoootify lyrics relay (runs inside the background helper, see watch.mjs).
 *
 * Some lyrics sources can't be queried from Spotify's page: NetEase sends no CORS headers, and
 * Musixmatch's working (iOS app) endpoint needs app headers a page can't set. This tiny server on
 * 127.0.0.1 does those lookups from Node instead. It is deliberately not a generic proxy: fixed
 * routes, fixed upstreams, answers only Spotify's own page origin, never listens on the network.
 *
 *   GET /v1/musixmatch?track=…&artist=…&album=…&duration=<s>&id=<spotify id>
 *     → 200 { id, name, artist, richsync }    real per-word timing
 *   GET /v1/netease?track=…&artist=…&duration=<seconds>
 *     → 200 { id, name, artists, lrc, yrc }   best match (lrc = line synced, yrc = word synced)
 *   either → 404 {}                           no confident match
 *
 *   node tools/lyrics-proxy.mjs   run standalone (for testing)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = 47321;
const ORIGIN = 'https://xpui.app.spotify.com';
const NE = 'https://music.163.com';
const NE_HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', referer: NE + '/' };
const cache = new Map(); // query → Promise<result|null>
const CACHE_MAX = 200;

async function getJSON(url, ms = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: NE_HEADERS, signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// lower-case, strip accents/punctuation, and drop "(feat. …)" / " - Remastered" style suffixes
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+-\s+.*$/, '')
  .replace(/[^\p{L}\p{N}]+/gu, '');

async function netease(track, artist, durationS) {
  const s = await getJSON(`${NE}/api/search/get?` + new URLSearchParams({ s: `${track} ${artist}`, type: 1, limit: 10 }));
  const songs = (s && s.result && s.result.songs) || [];
  const name = norm(track), who = norm(artist);
  let best = null, bestOff = Infinity;
  for (const x of songs) {
    if (norm(x.name) !== name) continue;
    if (who && !(x.artists || []).some((a) => norm(a.name) === who || norm(a.name).includes(who) || who.includes(norm(a.name)))) continue;
    const off = durationS ? Math.abs(x.duration / 1000 - durationS) : 0;
    if (off > 4) continue; // different edit/version: wrong timings would be worse than none
    if (off < bestOff) { best = x; bestOff = off; }
  }
  if (!best) return null;
  const l = await getJSON(`${NE}/api/song/lyric?id=${best.id}&lv=1&yv=1&tv=-1`);
  const lrc = l && l.lrc && l.lrc.lyric || '';
  const yrc = l && l.yrc && l.yrc.lyric || '';
  if (!lrc.trim() && !yrc.trim()) return null;
  return { id: best.id, name: best.name, artists: best.artists.map((a) => a.name), lrc, yrc };
}

// ── Musixmatch "richsync": real per-word timing (Spotify's own line lyrics come from Musixmatch).
// Same route the open-source lyrics-plus custom app uses: the iOS app endpoint, which hands out
// a working anonymous user token. The desktop/web endpoints give a dummy token + decoy lyrics.
const MXM = 'https://apic-appmobile.musixmatch.com/ws/1.1/';
const MXM_APP = 'mac-ios-v2.0';
const MXM_HEADERS = {
  'X-Cookie': 'x-mxm-token-guid=',
  'x-mxm-app-version': '10.1.1',
  'User-Agent': 'Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json',
};
let mxmToken = null, mxmTokenFile = null, mxmTokenWait = null, mxmBackoff = 0;

async function mxmGet(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: MXM_HEADERS, signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function mxmTokenGet(renew) {
  if (!renew && mxmToken) return mxmToken;
  if (!renew && mxmTokenFile) {
    try { mxmToken = JSON.parse(fs.readFileSync(mxmTokenFile, 'utf8')).token || null; } catch {}
    if (mxmToken) return mxmToken;
  }
  if (Date.now() < mxmBackoff) return null; // token.get is rate-limited (captcha) — don't hammer it
  if (!mxmTokenWait) {
    mxmTokenWait = (async () => {
      const j = await mxmGet(`${MXM}token.get?app_id=${MXM_APP}`);
      const tok = j && j.message && j.message.header.status_code === 200 && j.message.body && j.message.body.user_token;
      if (!tok || /^0+$|Upgrade/.test(tok)) { mxmBackoff = Date.now() + 10 * 60 * 1000; return null; }
      mxmToken = tok;
      if (mxmTokenFile) try { fs.writeFileSync(mxmTokenFile, JSON.stringify({ token: tok, at: Date.now() })); } catch {}
      return tok;
    })().finally(() => { mxmTokenWait = null; });
  }
  return mxmTokenWait;
}

async function musixmatch(q, retried) {
  const tok = await mxmTokenGet(retried);
  if (!tok) return null;
  const p = new URLSearchParams({
    format: 'json', namespace: 'lyrics_richsynched', subtitle_format: 'mxm', app_id: MXM_APP,
    q_track: q.track, q_artist: q.artist, q_artists: q.artist, q_album: q.album,
    q_duration: String(q.duration), f_subtitle_length: String(Math.floor(q.duration)),
    track_spotify_id: q.spotifyId ? 'spotify:track:' + q.spotifyId : '',
    usertoken: tok, optional_calls: 'track.richsync', richsync_compact_type: 'words',
  });
  const j = await mxmGet(MXM + 'macro.subtitles.get?' + p);
  const h = j && j.message && j.message.header;
  if (h && h.status_code === 401 && !retried) {
    // expired/renewable token → get a fresh one once
    mxmToken = null;
    if (mxmTokenFile) try { fs.rmSync(mxmTokenFile, { force: true }); } catch {}
    return musixmatch(q, true);
  }
  const mc = j && j.message && j.message.body && j.message.body.macro_calls;
  if (!mc) return null;
  const track = mc['matcher.track.get'] && mc['matcher.track.get'].message.body && mc['matcher.track.get'].message.body.track;
  if (!track || track.instrumental) return track && track.instrumental ? { instrumental: true } : null;
  // the matcher can fall back to a different song entirely; insist on a duration match
  if (q.duration && track.track_length && Math.abs(track.track_length - q.duration) > 4) return null;
  const rs = mc['track.richsync.get'] && mc['track.richsync.get'].message;
  let richsync = null;
  if (rs && rs.header.status_code === 200 && rs.body && rs.body.richsync) {
    try { richsync = JSON.parse(rs.body.richsync.richsync_body); } catch {}
  }
  if (!Array.isArray(richsync) || !richsync.length) return null;
  return { id: track.track_id, name: track.track_name, artist: track.artist_name, richsync };
}

export function startLyricsProxy(log = () => {}, dataDir = null) {
  if (dataDir) mxmTokenFile = path.join(dataDir, 'mxm-token.json');
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const head = { 'content-type': 'application/json', vary: 'origin' };
    if (origin === ORIGIN) {
      head['access-control-allow-origin'] = ORIGIN;
      head['access-control-allow-private-network'] = 'true';
    }
    // anything that isn't Spotify's page (other websites, other origins) gets nothing
    if (origin && origin !== ORIGIN) { res.writeHead(403, head); return res.end('{}'); }
    if (req.method === 'OPTIONS') { res.writeHead(204, head); return res.end(); }
    const u = new URL(req.url, 'http://127.0.0.1');
    const route = { '/v1/netease': 'ne', '/v1/musixmatch': 'mxm' }[u.pathname];
    if (req.method !== 'GET' || !route) { res.writeHead(404, head); return res.end('{}'); }
    const track = (u.searchParams.get('track') || '').slice(0, 200);
    const artist = (u.searchParams.get('artist') || '').slice(0, 200);
    const album = (u.searchParams.get('album') || '').slice(0, 200);
    const spotifyId = (u.searchParams.get('id') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    const duration = Math.max(0, Math.min(7200, +u.searchParams.get('duration') || 0));
    if (!track) { res.writeHead(400, head); return res.end('{}'); }
    const key = `${route}\n${track}\n${artist}\n${Math.round(duration)}\n${spotifyId}`;
    let p = cache.get(key);
    if (!p) {
      p = (route === 'ne' ? netease(track, artist, duration) : musixmatch({ track, artist, album, duration, spotifyId })).catch(() => null);
      cache.set(key, p);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    const out = await p;
    if (!out) cache.delete(key); // retry misses next time (could have been a network blip)
    res.writeHead(out ? 200 : 404, head);
    res.end(JSON.stringify(out || {}));
  });
  // after a self-update the new helper starts a moment before the old one exits and frees the
  // port — keep retrying for a while instead of giving up on the first EADDRINUSE
  let tries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && ++tries <= 20) { setTimeout(() => server.listen(PORT, '127.0.0.1'), 3000); return; }
    log(`lyrics relay not started: ${e.code || e.message}`);
  });
  server.on('listening', () => log(`lyrics relay on 127.0.0.1:${PORT}${tries ? ` (after ${tries} retr${tries > 1 ? 'ies' : 'y'})` : ''}`));
  server.listen(PORT, '127.0.0.1');
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startLyricsProxy(console.log, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
