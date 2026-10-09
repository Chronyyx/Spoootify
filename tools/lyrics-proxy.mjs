#!/usr/bin/env node
/*
 * Spoootify lyrics relay (runs inside the background helper, see watch.mjs).
 *
 * Some lyrics databases (NetEase Cloud Music) don't send CORS headers, so Spotify's page can't
 * query them directly. This tiny server on 127.0.0.1 does the lookup from Node instead. It is
 * deliberately not a generic proxy: one fixed route, one fixed upstream, answers only Spotify's
 * own page origin, and never listens on the network.
 *
 *   GET /v1/netease?track=…&artist=…&duration=<seconds>
 *     → 200 { id, name, artists, lrc, yrc }   best match (lrc = line synced, yrc = word synced)
 *     → 404 {}                                no confident match
 *
 *   node tools/lyrics-proxy.mjs   run standalone (for testing)
 */
import http from 'node:http';
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

export function startLyricsProxy(log = () => {}) {
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
    if (req.method !== 'GET' || u.pathname !== '/v1/netease') { res.writeHead(404, head); return res.end('{}'); }
    const track = (u.searchParams.get('track') || '').slice(0, 200);
    const artist = (u.searchParams.get('artist') || '').slice(0, 200);
    const duration = Math.max(0, Math.min(7200, +u.searchParams.get('duration') || 0));
    if (!track) { res.writeHead(400, head); return res.end('{}'); }
    const key = `${track}\n${artist}\n${Math.round(duration)}`;
    let p = cache.get(key);
    if (!p) {
      p = netease(track, artist, duration).catch(() => null);
      cache.set(key, p);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    const out = await p;
    if (!out) cache.delete(key); // retry misses next time (could have been a network blip)
    res.writeHead(out ? 200 : 404, head);
    res.end(JSON.stringify(out || {}));
  });
  server.on('error', (e) => log(`lyrics relay not started: ${e.code || e.message}`));
  server.listen(PORT, '127.0.0.1', () => log(`lyrics relay on 127.0.0.1:${PORT}`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startLyricsProxy(console.log);
