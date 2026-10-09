#!/usr/bin/env node
/*
 * Fluid Lyrics injector — patches Spotify's xpui.spa app shell. Zero dependencies (Node ≥ 18).
 *
 *   node tools/inject.mjs            inject (idempotent; re-run after every Spotify update)
 *   node tools/inject.mjs --restore  put the original xpui.spa back
 *   flags: --restart (close + relaunch Spotify)  --devtools (relaunch with remote debugging on :9222)
 *          --spotify <dir> (Spotify install dir, default %APPDATA%\Spotify)
 *
 * xpui.spa is a plain zip. We copy every untouched entry byte-for-byte (no recompression),
 * add /fluid-lyrics/* and add two tags to index.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZip, entryData, makeEntry, writeZip } from './zip.mjs';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const SPOTIFY = opt('--spotify') || path.join(process.env.APPDATA || '', 'Spotify');
const SPA = path.join(SPOTIFY, 'Apps', 'xpui.spa');
const BACKUP = SPA + '.fl-backup';
const MARK_A = '<!--fluid-lyrics-->';
const MARK_B = '<!--/fluid-lyrics-->';
const FILES = ['fluid-lyrics.js', 'fluid-lyrics.css', 'fl-engine.worker.js', 'fl-bg.worker.js'];

function die(msg, code = 1) { console.error('✖ ' + msg); process.exit(code); }

// ───────────── spotify process control ─────────────
const isWin = process.platform === 'win32';
function spotifyRunning() {
  try {
    return isWin
      ? execSync('tasklist /FI "IMAGENAME eq Spotify.exe" /NH', { encoding: 'utf8' }).includes('Spotify.exe')
      : !!execSync('pgrep -x spotify || true', { encoding: 'utf8' }).trim();
  } catch { return false; }
}
function killSpotify() {
  try { execSync(isWin ? 'taskkill /F /IM Spotify.exe' : 'pkill -x spotify', { stdio: 'ignore' }); } catch {}
  const until = Date.now() + 5000;
  while (spotifyRunning() && Date.now() < until) execSync(isWin ? 'ping -n 1 127.0.0.1 >NUL' : 'sleep 0.2');
}
function launchSpotify() {
  const exe = path.join(SPOTIFY, isWin ? 'Spotify.exe' : 'spotify');
  const a = flag('--devtools') ? ['--remote-debugging-port=9222', '--remote-allow-origins=*'] : [];
  spawn(exe, a, { detached: true, stdio: 'ignore' }).unref();
}

function writeSpa(buf) {
  const tmp = SPA + '.fl-tmp';
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, SPA);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    die(`couldn't replace xpui.spa (${e.code}). Close Spotify or pass --restart.`);
  }
}

// ───────────── main ─────────────
// exit code 3 = Spotify not installed (the watcher just waits); Store installs live in a read-only folder
if (!fs.existsSync(SPA)) die(`xpui.spa not found at ${SPA}. Install Spotify from spotify.com (the Microsoft Store version can't be modified).`, 3);
const wasRunning = spotifyRunning();
if (flag('--restart') && wasRunning) killSpotify();

if (flag('--restore')) {
  if (!fs.existsSync(BACKUP)) die('no backup found — nothing to restore');
  writeSpa(fs.readFileSync(BACKUP));
  console.log('✔ original xpui.spa restored');
} else {
  const spa = fs.readFileSync(SPA);
  const entries = readZip(spa);
  const idx = entries.find((e) => e.name === 'index.html');
  if (!idx) die('index.html missing from xpui.spa');
  let html = entryData(idx).toString('utf8');

  if (!html.includes(MARK_A)) {
    fs.writeFileSync(BACKUP, spa); // vanilla shell (fresh install or Spotify just updated) → refresh backup
    console.log('• backup written: ' + BACKUP);
  }
  // strip a previous injection, then add ours
  html = html.replace(new RegExp(`${MARK_A}[\\s\\S]*?${MARK_B}`, 'g'), '');
  const v = Date.now().toString(36); // cache-buster
  html = html.replace('</head>', `${MARK_A}<link rel="stylesheet" href="/fluid-lyrics/fluid-lyrics.css?v=${v}">${MARK_B}</head>`);
  html = html.replace('</body>', `${MARK_A}<script defer src="/fluid-lyrics/fluid-lyrics.js?v=${v}"></script>${MARK_B}</body>`);

  const out = entries.filter((e) => e.name !== 'index.html' && !e.name.startsWith('fluid-lyrics/'));
  out.push(makeEntry('index.html', Buffer.from(html, 'utf8')));
  for (const f of FILES) {
    const p = path.join(SRC, f);
    if (!fs.existsSync(p)) die('missing source file ' + p);
    out.push(makeEntry('fluid-lyrics/' + f, fs.readFileSync(p)));
  }
  writeSpa(writeZip(out));
  console.log(`✔ injected Fluid Lyrics into ${SPA}`);
}

if (flag('--restart') || flag('--devtools')) {
  if (flag('--devtools') && spotifyRunning()) killSpotify();
  launchSpotify();
  console.log('✔ Spotify relaunched');
} else if (wasRunning) {
  console.log('ℹ restart Spotify to load the change (or run with --restart)');
}
