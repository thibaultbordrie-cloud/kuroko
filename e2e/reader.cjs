// End-to-end for the reader: a real phone-sized browser on a local server, offline included.
const { chromium, devices } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = path.resolve("dist/site");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  if (!p.startsWith(root) || !fs.existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }).end(fs.readFileSync(p));
});
(async () => {
  await new Promise((r) => server.listen(4173, r));
  const shots = process.argv[2] || "shots";
  const errors = [];
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices["Pixel 7"], locale: "fr-FR" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto("http://localhost:4173/");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/reader-1-home.png` });
  await page.getByRole("button", { name: "Nouvelle partie" }).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${shots}/reader-2-scene.png` });
  // Two choices, then reload: the same page must come back.
  await page.locator(".choice").first().click();
  await page.waitForTimeout(600);
  await page.locator(".choice").first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/reader-3-echo.png` });
  const before = await page.locator(".scene").innerText();
  await page.reload();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Continuer" }).click();
  await page.waitForTimeout(600);
  const after = await page.locator(".scene").innerText();
  if (before !== after) errors.push("resume: the scene differs after reload");
  for (let i = 0; i < 30 && (await page.locator(".choice").count()) > 0; i++) {
    await page.locator(".choice").last().click();
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
  const ending = await page.locator(".ending h1").innerText().catch(() => "none");
  console.log(`ending reached: ${ending}`);
  await page.screenshot({ path: `${shots}/reader-4-ending.png` });
  // Import an adult pack: age gate, then listed.
  await page.getByRole("button", { name: "Packs" }).first().click();
  await page.waitForTimeout(400);
  await page.setInputFiles("#import", "build/adult-test.kuroko");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/reader-5-gate.png` });
  await page.getByRole("button", { name: /ans ou plus/ }).click();
  await page.waitForTimeout(500);
  const listed = await page.locator(".pack h2").allInnerTexts();
  console.log(`packs: ${listed.join(" | ")}`);
  // A tampered file is refused.
  const bad = JSON.parse(fs.readFileSync("build/adult-test.kuroko", "utf8"));
  bad.data = bad.data.slice(0, -8) + "AAAAAAAA";
  fs.writeFileSync("build/bad.kuroko", JSON.stringify(bad));
  await page.setInputFiles("#import", "build/bad.kuroko");
  await page.waitForTimeout(600);
  console.log(`tampered: ${await page.locator(".message").innerText().catch(() => "no message")}`);
  // Settings screen.
  await page.getByRole("button", { name: "Réglages" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/reader-6-settings.png`, fullPage: true });
  // Offline: the service worker must serve the app with the network gone.
  await page.goto("http://localhost:4173/");
  await page.waitForTimeout(1500);
  const sw = await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForTimeout(1000);
  const offline = await page.locator(".pack h2").count();
  console.log(`service worker: ${sw}; offline packs shown: ${offline}`);
  if (!offline) errors.push("offline: app did not load");
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) errors.push("horizontal overflow");
  console.log(errors.length ? errors.join("\n") : "no errors");
  await b.close();
  server.close();
})();
