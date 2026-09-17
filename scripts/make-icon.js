'use strict';

/**
 * 生成 build/icon.png（256×256）。
 * 纯 Node 实现，不依赖 canvas / sharp / PIL —— 免得为了一个图标再装一堆东西。
 * 图案：品牌蓝圆角方块 + 白色对话气泡 + 三条内容线。
 *
 *   npm run icon
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4; // 每像素 4×4 超采样，用来抗锯齿

const ACCENT = [0x4d, 0x6b, 0xfe];
const WHITE = [0xff, 0xff, 0xff];

/* ------------------------------ 几何判定 ------------------------------ */

function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function sign(ax, ay, bx, by, cx, cy) {
  return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
}

function inTriangle(px, py, a, b, c) {
  const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
  const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
  const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ------------------------------ 图形定义 ------------------------------ */

// 背景：满幅圆角方块
const BG = { x0: 0, y0: 0, x1: SIZE, y1: SIZE, r: 56 };
// 气泡主体
const BUBBLE = { x0: 44, y0: 50, x1: 212, y1: 170, r: 32 };
// 气泡尾巴（左下角）
const TAIL = [
  [66, 148],
  [66, 210],
  [124, 156],
];
// 气泡里的三条内容线
const BARS = [
  { x0: 78, y0: 84, x1: 178, y1: 100, r: 8 },
  { x0: 78, y0: 112, x1: 162, y1: 128, r: 8 },
  { x0: 78, y0: 140, x1: 140, y1: 156, r: 8 },
];

function sample(px, py) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;

  const over = (color, alpha) => {
    if (alpha <= 0) return;
    const na = alpha + a * (1 - alpha);
    if (na <= 0) {
      a = 0;
      return;
    }
    r = (color[0] * alpha + r * a * (1 - alpha)) / na;
    g = (color[1] * alpha + g * a * (1 - alpha)) / na;
    b = (color[2] * alpha + b * a * (1 - alpha)) / na;
    a = na;
  };

  if (inRoundRect(px, py, BG.x0, BG.y0, BG.x1, BG.y1, BG.r)) over(ACCENT, 1);
  if (inRoundRect(px, py, BUBBLE.x0, BUBBLE.y0, BUBBLE.x1, BUBBLE.y1, BUBBLE.r)) over(WHITE, 1);
  if (inTriangle(px, py, TAIL[0], TAIL[1], TAIL[2])) over(WHITE, 1);
  for (const bar of BARS) {
    if (inRoundRect(px, py, bar.x0, bar.y0, bar.x1, bar.y1, bar.r)) over(ACCENT, 1);
  }
  return [r, g, b, a];
}

/* ------------------------------ PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 主流程 ------------------------------ */

function render() {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step);
          // 按 alpha 加权累加，最后再归一
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const idx = (y * SIZE + x) * 4;
      if (alpha > 0) {
        out[idx] = Math.round(Math.min(255, r / a));
        out[idx + 1] = Math.round(Math.min(255, g / a));
        out[idx + 2] = Math.round(Math.min(255, b / a));
      }
      out[idx + 3] = Math.round(Math.min(255, alpha * 255));
    }
  }
  return out;
}

function main() {
  const targets = [
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(__dirname, '..', 'build', 'tray.png'),
  ];
  const rgba = render();
  const png = encodePng(SIZE, SIZE, rgba);
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, png);
    console.log(`已生成 ${target} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
  }
}

main();
