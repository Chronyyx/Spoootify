#!/usr/bin/env node
/*
 * Spoootify installer / uninstaller (called by install.bat / uninstall.bat).
 *
 *   install    copy to %LOCALAPPDATA%\Spoootify, inject into Spotify, and register the background
 *              helper (auto-update + auto-reapply) to start hidden at logon (per-user, no admin)
 *   uninstall  stop + unregister the helper, restore Spotify's original shell, delete files
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NAME } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');                       // folder this copy runs from
const LOCAL = process.env.LOCALAPPDATA || '';
const DEST = path.join(LOCAL, NAME);
const LEGACY = path.join(LOCAL, 'FluidLyrics');              // pre-Spoootify installs
const STARTUP = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const VBS = path.join(STARTUP, NAME + '.vbs');
const LEGACY_VBS = path.join(STARTUP, 'FluidLyrics.vbs');
const NODE = process.execPath;
const mode = process.argv[2];

const ok = (m) => console.log('  ✔ ' + m);
const info = (m) => console.log('  • ' + m);
const run = (script, args) => spawnSync(NODE, [script, ...args], { stdio: 'inherit', windowsHide: true });
function spotifyRunning() {
  try { return execSync('tasklist /FI "IMAGENAME eq Spotify.exe" /NH', { encoding: 'utf8', windowsHide: true }).includes('Spotify.exe'); } catch { return false; }
}
function stopWatcher(dir = DEST) {
  const w = path.join(dir, 'tools', 'watch.mjs');
  if (fs.existsSync(w)) spawnSync(NODE, [w, '--stop'], { windowsHide: true });
}
function removeLegacy() {
  if (!fs.existsSync(LEGACY) && !fs.existsSync(LEGACY_VBS)) return;
  stopWatcher(LEGACY);
  fs.rmSync(LEGACY_VBS, { force: true });
  fs.rmSync(LEGACY, { recursive: true, force: true });
  ok('removed the old standalone FluidLyrics install (it is part of Spoootify now)');
}
// delete a folder we may be running from: hand it to cmd after we exit.
// windowsVerbatimArguments: Node's default arg quoting (\" escapes) isn't understood by cmd.exe
function removeDirLater(dir) {
  spawn('cmd.exe', ['/d /s /c "ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + dir + '""'], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

if (process.platform !== 'win32') {
  console.error('This installer is for Windows.');
  process.exit(1);
}

if (mode === 'install') {
  console.log(`\nInstalling ${NAME}…\n`);
  stopWatcher();
  removeLegacy();

  // 1) stable home, independent of where the zip was extracted
  if (path.resolve(PKG) !== path.resolve(DEST)) {
    fs.mkdirSync(DEST, { recursive: true });
    for (const d of ['src', 'tools']) {
      fs.rmSync(path.join(DEST, d), { recursive: true, force: true });
      fs.cpSync(path.join(PKG, d), path.join(DEST, d), { recursive: true });
    }
    for (const f of ['version.json', 'install.bat', 'uninstall.bat', 'README.txt', 'BLUEPRINT.md']) {
      if (fs.existsSync(path.join(PKG, f))) fs.copyFileSync(path.join(PKG, f), path.join(DEST, f));
    }
  }
  ok('files installed to ' + DEST);

  // 2) inject now
  const r = run(path.join(DEST, 'tools', 'inject.mjs'), ['--restart']);
  if (r.status === 3) info("Spotify isn't installed yet — it will be patched automatically once it is.");
  else if (r.status !== 0) info('injection failed for now; the background helper will retry.');

  // 3) background helper: hidden at every logon, started right away too
  fs.mkdirSync(STARTUP, { recursive: true });
  const watch = path.join(DEST, 'tools', 'watch.mjs');
  fs.writeFileSync(VBS, `' ${NAME} helper: auto-update from GitHub + re-patch Spotify after its updates\r\nCreateObject("WScript.Shell").Run """${NODE}"" ""${watch}""", 0, False\r\n`);
  spawn('wscript.exe', [VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  ok('background helper running and set to start with Windows (auto-update + auto-reapply)');

  console.log(`\nDone. Open Spotify and click the lyrics button (the mic icon in the player bar).
To remove it later, run "${path.join(DEST, 'uninstall.bat')}".\n`);
} else if (mode === 'uninstall') {
  console.log(`\nRemoving ${NAME}…\n`);
  stopWatcher();
  fs.rmSync(VBS, { force: true });
  removeLegacy();
  ok('background helper stopped and removed from startup');

  const inject = fs.existsSync(path.join(DEST, 'tools', 'inject.mjs')) ? path.join(DEST, 'tools', 'inject.mjs') : path.join(PKG, 'tools', 'inject.mjs');
  const r = run(inject, ['--restore', ...(spotifyRunning() ? ['--restart'] : [])]);
  if (r.status === 0) ok("Spotify's original files restored");
  else info('nothing to restore (Spotify may have updated since — it is already vanilla).');

  if (fs.existsSync(DEST)) {
    if (path.resolve(PKG) === path.resolve(DEST)) removeDirLater(DEST);
    else fs.rmSync(DEST, { recursive: true, force: true });
  }
  ok('files removed');
  console.log(`\n${NAME} is uninstalled.\n`);
} else {
  console.log('usage: node tools/setup.mjs install|uninstall');
  process.exit(1);
}
