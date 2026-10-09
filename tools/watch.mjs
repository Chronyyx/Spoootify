#!/usr/bin/env node
/*
 * Spoootify background helper. Started hidden at logon (see setup.mjs). Two jobs:
 *
 * 1. Auto-update: shortly after boot and every few hours, check the GitHub release; if a newer
 *    *signed* release exists, swap it in (update.mjs), re-inject, and restart this helper.
 *
 * 2. Auto-reapply:
 *
 *    Spotify's updater replaces Apps/xpui.spa with a vanilla copy. We notice (filesystem watch +
 * 60 s fallback poll, both near-zero cost), wait until the file has stopped changing, and if
 * our files are gone we re-run the injector — restarting Spotify only if it is open.
 *
 *   node tools/watch.mjs          run (single instance; a second copy exits immediately)
 *   node tools/watch.mjs --stop   stop a running watcher
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isInjected } from './zip.mjs';
import { checkForUpdate, localVersion } from './update.mjs';
import { NAME, UPDATE_EVERY_MS } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..');
const INJECT = path.join(HERE, 'inject.mjs');
const PIDFILE = path.join(DIR, 'watch.pid');
const LOG = path.join(DIR, 'watch.log');
const APPS = path.join(process.env.APPDATA || '', 'Spotify', 'Apps');
const SPA = path.join(APPS, 'xpui.spa');
const VBS = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', NAME + '.vbs');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = () => { try { return +fs.readFileSync(PIDFILE, 'utf8') || 0; } catch { return 0; } };

if (process.argv.includes('--stop')) {
  const pid = readPid();
  if (pid && alive(pid)) { try { process.kill(pid); } catch {} }
  fs.rmSync(PIDFILE, { force: true });
  process.exit(0);
}

// single instance
const other = readPid();
if (other && other !== process.pid && alive(other)) process.exit(0);
fs.writeFileSync(PIDFILE, String(process.pid));
const cleanup = () => { if (readPid() === process.pid) fs.rmSync(PIDFILE, { force: true }); };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));

function log(msg) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${msg}\n`);
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signature = () => { try { const st = fs.statSync(SPA); return `${st.size}:${st.mtimeMs}`; } catch { return ''; } };
function spotifyRunning() {
  try { return execSync('tasklist /FI "IMAGENAME eq Spotify.exe" /NH', { encoding: 'utf8', windowsHide: true }).includes('Spotify.exe'); } catch { return false; }
}

let checked = '';      // signature of the xpui.spa we last verified as injected
let busy = false;
let retryAfter = 0;    // back-off after a failed injection

async function check(reason) {
  if (busy) return;
  busy = true;
  try {
    let sig = signature();
    if (!sig || sig === checked || Date.now() < retryAfter) return;
    // let the updater finish writing: require the file to be unchanged for 4 s
    for (;;) {
      await sleep(4000);
      const again = signature();
      if (again === sig) break;
      if (!again) return;
      sig = again;
    }
    if (isInjected(SPA)) { checked = sig; return; }
    const running = spotifyRunning();
    log(`xpui.spa is vanilla (${reason}) → re-injecting${running ? ' and restarting Spotify' : ''}`);
    const r = spawnSync(process.execPath, [INJECT, ...(running ? ['--restart'] : [])], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (r.status === 0) {
      checked = signature();
      log('re-injected OK');
    } else {
      retryAfter = Date.now() + 10 * 60 * 1000;
      log(`inject failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    }
  } finally {
    busy = false;
  }
}

let debounce = 0;
const nudge = (reason) => { clearTimeout(debounce); debounce = setTimeout(() => check(reason), 1500); };

function watchApps() {
  try {
    const w = fs.watch(APPS, (_e, file) => { if (!file || /^xpui\.spa$/i.test(String(file))) nudge('file changed'); });
    w.on('error', () => setTimeout(watchApps, 30000));
  } catch {
    setTimeout(watchApps, 30000); // Spotify not installed yet — try again later
  }
}

// ── auto-update ──
let updating = false;
async function updateCycle(reason) {
  if (updating || busy) return;
  updating = true;
  try {
    const r = await checkForUpdate(DIR);
    log(`update check (${reason}): ${r.status}${r.to ? ` ${r.from} → ${r.to}` : ''}`);
    if (r.status.startsWith('offline') && reason !== 'retry') setTimeout(() => updateCycle('retry'), 10 * 60 * 1000);
    if (r.status !== 'updated') return;
    const running = spotifyRunning();
    const inj = spawnSync(process.execPath, [INJECT, ...(running ? ['--restart'] : [])], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    log(inj.status === 0 ? 're-injected with the new version' : `inject after update failed: ${(inj.stderr || '').trim().slice(0, 300)}`);
    // hand over to the new helper code
    fs.rmSync(PIDFILE, { force: true });
    if (fs.existsSync(VBS)) spawn('wscript.exe', [VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.execPath, [path.join(HERE, 'watch.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('restarting helper on the new version');
    setTimeout(() => process.exit(0), 300);
  } catch (e) {
    log('update check error: ' + (e && e.message));
  } finally {
    updating = false;
  }
}

log(`helper started (pid ${process.pid}, version ${localVersion(DIR)})`);
setTimeout(() => updateCycle('boot'), 20000); // give the network a moment after logon
setInterval(() => updateCycle('periodic'), UPDATE_EVERY_MS);
watchApps();
setInterval(() => check('periodic'), 60000);
check('startup');
