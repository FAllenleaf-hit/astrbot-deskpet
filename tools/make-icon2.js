/**
 * 用角色头像合成桌面图标
 * electron tools/make-icon2.js <头部裁切图> <输出png> <输出ico>
 */
const { app, nativeImage } = require('electron');
const fs = require('fs');

const S = 512;                 // 合成画布尺寸
const RADIUS = 116;            // 圆角半径（squircle 风格）
const C_TOP = [0x6b, 0x46, 0xe5];   // 渐变上（紫）
const C_BOT = [0xd0, 0x6b, 0xd9];   // 渐变下（粉紫）

function bgraToU32(b, i) {
  return { B: b[i], G: b[i + 1], R: b[i + 2], A: b[i + 3] };
}

app.whenReady().then(() => {
  const [src, outPng, outIco] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const headImg = nativeImage.createFromPath(src);
  const hs = headImg.getSize();
  const hb = headImg.toBitmap();          // BGRA

  // 1) 自动裁掉透明边
  let x0 = hs.width, y0 = hs.height, x1 = -1, y1 = -1;
  for (let y = 0; y < hs.height; y++) for (let x = 0; x < hs.width; x++) {
    if (hb[(y * hs.width + x) * 4 + 3] > 12) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const hw = x1 - x0 + 1, hh = y1 - y0 + 1;
  console.log('头部实际尺寸:', hw + 'x' + hh, '（裁切自', hs.width + 'x' + hs.height + '）');

  // 2) 目标尺寸：宽度占画布 92%
  const scale = (S * 0.92) / hw;
  const dw = Math.round(hw * scale), dh = Math.round(hh * scale);
  const dx = Math.round((S - dw) / 2);
  const dy = Math.round(S - dh + 6);       // 底部略微出血，像头像特写

  // 3) 画布：圆角渐变 + 内侧高光描边
  const canvas = Buffer.alloc(S * S * 4);
  const r2 = RADIUS;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // 圆角矩形遮罩
      let inside = true;
      const cx = x < r2 ? r2 : (x > S - r2 ? S - r2 : x);
      const cy = y < r2 ? r2 : (y > S - r2 ? S - r2 : y);
      const ddx = x - cx, ddy = y - cy;
      if (ddx * ddx + ddy * ddy > r2 * r2) inside = false;
      if (!inside) { canvas[i + 3] = 0; continue; }
      const t = y / (S - 1);
      let R = C_TOP[0] + (C_BOT[0] - C_TOP[0]) * t;
      let G = C_TOP[1] + (C_BOT[1] - C_TOP[1]) * t;
      let B = C_TOP[2] + (C_BOT[2] - C_TOP[2]) * t;
      // 左上柔光
      const gx = x / S - 0.25, gy = y / S - 0.2;
      const glow = Math.max(0, 1 - Math.sqrt(gx * gx + gy * gy) * 1.6) * 0.22;
      R = R + (255 - R) * glow; G = G + (255 - G) * glow; B = B + (255 - B) * glow;
      // 内侧描边（浅色）
      const edge = Math.min(x, y, S - 1 - x, S - 1 - y);
      if (edge < 3) {
        const a = 0.30 * (1 - edge / 3);
        R = R + (255 - R) * a; G = G + (255 - G) * a; B = B + (255 - B) * a;
      }
      canvas[i] = B; canvas[i + 1] = G; canvas[i + 2] = R; canvas[i + 3] = 255;
    }
  }

  // 4) 叠头像（BGRA 直接混合）
  const headScaled = headImg.crop({ x: x0, y: y0, width: hw, height: hh })
    .resize({ width: dw, height: dh, quality: 'best' });
  const sb = headScaled.toBitmap();
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const px = dx + x, py = dy + y;
      if (px < 0 || py < 0 || px >= S || py >= S) continue;
      const si = (y * dw + x) * 4, di = (py * S + px) * 4;
      if (canvas[di + 3] === 0) continue;      // 圆角外不画
      const a = sb[si + 3] / 255;
      if (a <= 0) continue;
      canvas[di] = Math.round(sb[si] * a + canvas[di] * (1 - a));
      canvas[di + 1] = Math.round(sb[si + 1] * a + canvas[di + 1] * (1 - a));
      canvas[di + 2] = Math.round(sb[si + 2] * a + canvas[di + 2] * (1 - a));
    }
  }

  const composed = nativeImage.createFromBitmap(canvas, { width: S, height: S });
  // 5) 输出 256 png
  const png256 = composed.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  fs.writeFileSync(outPng, png256);
  console.log('已写出', outPng, png256.length, '字节');

  // 6) 输出多尺寸 ico（PNG 内嵌）
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => composed.resize({ width: s, height: s, quality: 'best' }).toPNG());
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const dirs = [];
  let offset = 6 + 16 * count;
  sizes.forEach((s, i) => {
    const d = Buffer.alloc(16);
    d[0] = s >= 256 ? 0 : s; d[1] = s >= 256 ? 0 : s;
    d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32LE(pngs[i].length, 8);
    d.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    dirs.push(d);
  });
  fs.writeFileSync(outIco, Buffer.concat([header, ...dirs, ...pngs]));
  console.log('已写出', outIco, '尺寸:', sizes.join('/'));
  app.quit();
});
