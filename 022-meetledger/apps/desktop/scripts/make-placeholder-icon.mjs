// Writes a simple 1024×1024 placeholder PNG to build/icon.png ONLY when the brand icon is missing.
// (electron-builder derives .ico / .icns from build/icon.png; the real icon comes from the brand team.)
// Run directly: node scripts/make-placeholder-icon.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

function crc32(buf) {
  let c;
  const table = (crc32.t ??= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function placeholderPng(size = 1024) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.2; // corner radius
  const inset = size * 0.06;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // rounded square
      const cx = Math.min(Math.max(x, inset + r), size - inset - r);
      const cy = Math.min(Math.max(y, inset + r), size - inset - r);
      const inside = Math.hypot(x - cx, y - cy) <= r;
      if (!inside) continue;
      let [R, G, B] = [37, 99, 235]; // blue
      // three white "ledger" lines + a red recording dot
      const u = x / size;
      const v = y / size;
      const line = (v0) => v > v0 && v < v0 + 0.07 && u > 0.22 && u < 0.62;
      if (line(0.3) || line(0.46) || line(0.62)) [R, G, B] = [255, 255, 255];
      if (Math.hypot(u - 0.74, v - 0.66) < 0.09) [R, G, B] = [239, 68, 68];
      raw[i] = R;
      raw[i + 1] = G;
      raw[i + 2] = B;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Returns the icon path; creates build/icon.png from the placeholder when missing. */
export function ensureIcon(iconPath) {
  if (fs.existsSync(iconPath)) {
    const placeholder = fs.existsSync(`${iconPath}.placeholder`);
    return { path: iconPath, placeholder };
  }
  fs.mkdirSync(path.dirname(iconPath), { recursive: true });
  fs.writeFileSync(iconPath, placeholderPng());
  // marker so builds can report that the brand icon is still missing; delete it together with icon.png
  fs.writeFileSync(`${iconPath}.placeholder`, 'build/icon.png is a generated placeholder. Replace it with the brand icon (1024x1024 PNG) and delete this file.\n');
  console.warn('[icon] build/icon.png was missing — generated a placeholder');
  return { path: iconPath, placeholder: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = ensureIcon(path.join(root, 'build/icon.png'));
  console.log(r.placeholder ? 'placeholder icon in place' : 'brand icon present');
}
