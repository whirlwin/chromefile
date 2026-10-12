// Renders static/icons/icon{16,32,48,128}.png: a Claude-orange rounded square
// with a white "C". Plain node, no image tooling needed. Re-run after editing.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const ORANGE = [0xd9, 0x77, 0x57];
const WHITE = [0xff, 0xff, 0xff];
const SAMPLES = 4; // supersampling per axis, for anti-aliasing

// Returns the colour at (x, y) in unit coordinates, or null when transparent.
function shade(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if (Math.hypot(x - cx, y - cy) > r) return null;

  const dx = x - 0.5;
  const dy = y - 0.5;
  const dist = Math.hypot(dx, dy);
  const angle = Math.abs(Math.atan2(dy, dx));
  const inRing = dist <= 0.31 && dist >= 0.18;
  const inGap = angle < Math.PI / 4.5;
  return inRing && !inGap ? WHITE : ORANGE;
}

function render(size) {
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = [0]; // PNG filter type: none
    for (let px = 0; px < size; px++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = shade((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const n = SAMPLES * SAMPLES;
      row.push(a ? Math.round(r / a) : 0, a ? Math.round(g / a) : 0, a ? Math.round(b / a) : 0, Math.round((a / n) * 255));
    }
    rows.push(Buffer.from(row));
  }
  return png(size, Buffer.concat(rows));
}

function png(size, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const dir = new URL("../static/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`icon${size}.png`, dir), render(size));
}
