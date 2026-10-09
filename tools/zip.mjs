/*
 * Minimal zip reader/writer (store + deflate), zero dependencies, Node ≥ 18.
 * Untouched entries are copied byte-for-byte; only new/changed entries are compressed.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

// CRC-32 (IEEE) — zlib.crc32 only exists on Node ≥ 22.2, friends may have older Node
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12), date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnl = buf.readUInt16LE(lho + 26), lxl = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnl + lxl;
    entries.push({ name, method, time, date, crc, csize, usize, raw: buf.subarray(start, start + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

export function entryData(e) {
  if (e.method === 0) return Buffer.from(e.raw);
  if (e.method === 8) return zlib.inflateRawSync(e.raw);
  throw new Error(`unsupported zip method ${e.method} for ${e.name}`);
}

export function makeEntry(name, data, date = new Date()) {
  const raw = zlib.deflateRawSync(data, { level: 9 });
  return {
    name, method: 8, crc: crc32(data), csize: raw.length, usize: data.length, raw,
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function writeZip(entries) {
  const chunks = [], central = [];
  let off = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(e.method, 8); lh.writeUInt16LE(e.time, 10); lh.writeUInt16LE(e.date, 12);
    lh.writeUInt32LE(e.crc, 14); lh.writeUInt32LE(e.csize, 18); lh.writeUInt32LE(e.usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, e.raw);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(e.method, 10); ch.writeUInt16LE(e.time, 12); ch.writeUInt16LE(e.date, 14);
    ch.writeUInt32LE(e.crc, 16); ch.writeUInt32LE(e.csize, 20); ch.writeUInt32LE(e.usize, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nameBuf);
    off += 30 + nameBuf.length + e.raw.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cd, end]);
}

/** Cheap check used by the watcher: does this xpui.spa already carry our files? */
export function isInjected(spaPath) {
  try {
    return readZip(fs.readFileSync(spaPath)).some((e) => e.name === 'fluid-lyrics/fluid-lyrics.js');
  } catch {
    return false;
  }
}
