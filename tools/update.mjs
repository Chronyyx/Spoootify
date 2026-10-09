/*
 * Spoootify updater: fetch the latest GitHub release, verify its Ed25519 signature against the
 * public key shipped with the install, and swap the new files in.
 *
 * Safety rules:
 *  - nothing is unpacked unless the zip's signature verifies (key never leaves the publisher's PC)
 *  - the version *inside* the signed zip must be newer than the installed one, so a re-uploaded
 *    old signed zip under a new tag can't downgrade anyone
 *  - entry names are validated, so a zip can't write outside the install folder
 *  - new files are staged first, then swapped in; the previous copy is kept until the swap succeeds
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readZip, entryData } from './zip.mjs';
import { REPO, ASSET, PUBLIC_KEY, NAME } from './config.mjs';

const UA = { 'User-Agent': `${NAME}-updater`, Accept: 'application/vnd.github+json' };
const REQUIRED = ['version.json', 'src/fluid-lyrics.js', 'src/fluid-lyrics.css', 'src/fl-engine.worker.js', 'src/fl-bg.worker.js',
  'tools/inject.mjs', 'tools/zip.mjs', 'tools/watch.mjs', 'tools/setup.mjs', 'tools/update.mjs', 'tools/config.mjs'];

export function localVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}
export function compareVersions(a, b) {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0), y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
export function verifySignature(zipBuf, sigText) {
  try {
    return crypto.verify(null, zipBuf, crypto.createPublicKey(PUBLIC_KEY), Buffer.from(String(sigText).trim(), 'base64'));
  } catch {
    return false;
  }
}

async function get(url, ms) {
  const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

/** @returns {Promise<{status: string, from?: string, to?: string}>} */
export async function checkForUpdate(dir) {
  const local = localVersion(dir);
  let rel;
  try {
    rel = await (await get(`https://api.github.com/repos/${REPO}/releases/latest`, 15000)).json();
  } catch (e) {
    return { status: `offline or no release (${e.message})` };
  }
  const tag = String(rel.tag_name || '').replace(/^v/i, '');
  if (compareVersions(tag, local) <= 0) return { status: `up to date (${local})` };
  const zipA = (rel.assets || []).find((a) => a.name === ASSET);
  const sigA = (rel.assets || []).find((a) => a.name === ASSET + '.sig');
  if (!zipA || !sigA) return { status: `release ${tag} has no signed ${ASSET}` };

  const zip = Buffer.from(await (await get(zipA.browser_download_url, 120000)).arrayBuffer());
  const sig = await (await get(sigA.browser_download_url, 30000)).text();
  if (!verifySignature(zip, sig)) return { status: `REJECTED ${tag}: signature does not match the publisher key` };

  // unpack (validated names only)
  const files = new Map();
  for (const e of readZip(zip)) {
    if (e.name.endsWith('/')) continue;
    const rel = e.name.replace(new RegExp(`^${NAME}/`), '');
    if (rel.includes('..') || path.isAbsolute(rel) || !/^[\w .\-\/]+$/.test(rel)) return { status: `REJECTED ${tag}: unsafe path ${e.name}` };
    files.set(rel, entryData(e));
  }
  for (const f of REQUIRED) if (!files.has(f)) return { status: `REJECTED ${tag}: missing ${f}` };
  const inner = JSON.parse(files.get('version.json').toString('utf8')).version;
  if (compareVersions(inner, local) <= 0) return { status: `REJECTED ${tag}: signed contents are version ${inner}, not newer than ${local}` };

  // stage
  const stage = path.join(dir, '.update');
  fs.rmSync(stage, { recursive: true, force: true });
  for (const [rel, data] of files) {
    const p = path.join(stage, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
  // swap top-level items (src/, tools/, version.json, bats, docs); keep old until done
  const old = path.join(dir, '.previous');
  fs.rmSync(old, { recursive: true, force: true });
  fs.mkdirSync(old, { recursive: true });
  for (const item of fs.readdirSync(stage)) {
    const cur = path.join(dir, item);
    if (fs.existsSync(cur)) fs.renameSync(cur, path.join(old, item));
    fs.renameSync(path.join(stage, item), cur);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  return { status: 'updated', from: local, to: inner };
}
