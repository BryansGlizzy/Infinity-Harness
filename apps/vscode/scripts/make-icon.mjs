// Draws media/icon.png (the Marketplace icon): an infinity sign on a dark rounded square. No dependencies; run with
// `pnpm --filter infinity-harness icon`. The PNG is committed, so this only needs running to change the design.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const SS = 3; // supersampling per axis
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');

// Points along a lemniscate of Gerono-ish shape (a smooth horizontal figure eight), centred in the square.
const curve = [];
for (let i = 0; i < 2000; i++) {
  const t = (i / 2000) * Math.PI * 2;
  const d = 1 + Math.sin(t) ** 2;
  curve.push([SIZE / 2 + ((SIZE * 0.36 * Math.cos(t)) / d) * 1.18, SIZE / 2 + ((SIZE * 0.36 * Math.sin(t) * Math.cos(t)) / d) * 1.18]);
}
const STROKE = SIZE * 0.055;

function distToCurve(x, y) {
  let best = Infinity;
  for (const [cx, cy] of curve) {
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// Rounded square mask.
const R = SIZE * 0.2;
function inSquare(x, y) {
  const dx = Math.max(R - x, 0, x - (SIZE - R));
  const dy = Math.max(R - y, 0, y - (SIZE - R));
  return dx * dx + dy * dy <= R * R;
}

const bg = [16, 24, 40];
const a = [96, 165, 250]; // left lobe
const b = [167, 139, 250]; // right lobe
const rows = [];
for (let py = 0; py < SIZE; py++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let px = 0; px < SIZE; px++) {
    let cov = 0; // how much of the pixel is inside the stroke
    let sq = 0; // and inside the square
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS;
        const y = py + (sy + 0.5) / SS;
        if (inSquare(x, y)) sq++;
        if (distToCurve(x, y) <= STROKE / 2) cov++;
      }
    }
    const n = SS * SS;
    const k = cov / n;
    const t = px / SIZE;
    const ink = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const o = 1 + px * 4;
    for (let i = 0; i < 3; i++) row[o + i] = Math.round(bg[i] * (1 - k) + ink[i] * k);
    row[o + 3] = Math.round((sq / n) * 255);
  }
  rows.push(row);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${out}`);
