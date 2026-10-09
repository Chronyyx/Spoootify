#!/usr/bin/env node
/*
 * One-time: create the release-signing key pair.
 *   private key → %USERPROFILE%\.spoootify\release-key.pem   (keep it; back it up; never commit)
 *   public key  → written into tools/config.mjs                (shipped to every install)
 * Refuses to overwrite an existing private key: losing/replacing it means installed copies
 * will reject every future update until they are reinstalled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const KEY_DIR = path.join(os.homedir(), '.spoootify');
const KEY = path.join(KEY_DIR, 'release-key.pem');
const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.mjs');

if (fs.existsSync(KEY)) {
  console.error(`✖ ${KEY} already exists — not overwriting your signing key.`);
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(KEY_DIR, { recursive: true });
fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' }).trim();
const cfg = fs.readFileSync(CONFIG, 'utf8').replace(/export const PUBLIC_KEY = `[\s\S]*?`;/, () => `export const PUBLIC_KEY = \`${pub}\`;`);
fs.writeFileSync(CONFIG, cfg);
console.log(`✔ private key: ${KEY}  (back this file up somewhere safe)`);
console.log('✔ public key written into tools/config.mjs');
