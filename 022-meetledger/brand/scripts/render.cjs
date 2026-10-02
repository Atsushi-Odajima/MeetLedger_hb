// MeetLedger brand renderer: rasterises SVG/HTML with Playwright's Chromium.
// Usage: node brand/scripts/render.cjs <jobs.json>
//   jobs.json = [{ in, out, w, h, scale?, transparent?, fit?: "img", bg?, fullPage?, wait?, colorScheme? }]
//   fit:"img" wraps an SVG in an <img> sized w x h (crisp small-size rendering).
// Env: CHROMIUM_PATH (default: Playwright's bundled Chromium)
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../node_modules/playwright-core'));

(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  // offline rendering: no background network traffic from Chromium
  const launch = { args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] };
  const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  else if (fs.existsSync(fallback)) launch.executablePath = fallback;
  const browser = await chromium.launch(launch);
  for (const j of jobs) {
    const ctx = await browser.newContext({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: j.scale || 1, colorScheme: j.colorScheme || 'light' });
    const page = await ctx.newPage();
    const abs = path.resolve(j.in);
    let tmp = null;
    if (j.fit === 'img') {
      const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:${j.bg || 'transparent'}}img{display:block;width:${j.w}px;height:${j.h}px}</style></head><body><img src="file://${abs}"></body></html>`;
      tmp = abs + '.render.html';
      fs.writeFileSync(tmp, html);
      await page.goto('file://' + tmp);
    } else {
      await page.goto('file://' + abs);
    }
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(j.wait || 80);
    await page.screenshot({ path: j.out, omitBackground: !!j.transparent, fullPage: !!j.fullPage });
    if (tmp) fs.unlinkSync(tmp);
    await ctx.close();
    console.log('rendered', path.relative(process.cwd(), j.out));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
