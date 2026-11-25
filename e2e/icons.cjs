// Draws the app icons once: two kanji on a dark tile. Run: node e2e/icons.cjs
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  for (const size of [192, 512]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<body style="margin:0"><div style="width:${size}px;height:${size}px;background:#0d0f12;display:flex;align-items:center;justify-content:center;">
      <div style="writing-mode:vertical-rl;font:700 ${Math.round(size * 0.3)}px 'Noto Serif CJK JP','Noto Serif CJK TC',serif;color:#e4e1da;line-height:1;border:${Math.max(2, Math.round(size / 64))}px solid #e08a4f;padding:${Math.round(size * 0.04)}px ${Math.round(size * 0.02)}px">黒子</div></div></body>`);
    await p.screenshot({ path: `src/play/icons/icon-${size}.png` });
    await p.close();
  }
  await b.close();
})();
