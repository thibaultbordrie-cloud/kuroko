// End-to-end: the standalone page under its strict CSP, in a real browser.
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const path = require("path");
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const shots = process.argv[2] || "shots";
  const url = "file://" + path.resolve("dist/kuroko.html");
  for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 780, isMobile: true, hasTouch: true }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, locale: "fr-FR" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${vp.name} pageerror: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${vp.name} console: ${m.text()}`));
    await page.goto(url);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${shots}/${vp.name}-1-title.png` });
    await page.getByRole("button", { name: "Nouvelle campagne" }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${vp.name}-2-network.png` });
    const save = JSON.parse(await page.evaluate(() => localStorage.getItem("kuroko.save.v1")));
    await page.locator(".op").first().click();
    await page.locator(".agent .btn.primary").first().click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${shots}/${vp.name}-3-mission.png` });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) errors.push(`${vp.name}: horizontal overflow`);
    if (vp.name === "desktop") {
      await page.keyboard.press("KeyV");
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/${vp.name}-4-forecast.png` });
      await page.keyboard.press("KeyV");
      // Play the proven ghost route with the keyboard, then check the result and the save.
      const plan = JSON.parse(execFileSync("node", ["build/ghost-keys.mjs", save.seed, "0"]).toString());
      for (let i = 0; i < plan.keys.length; i++) {
        await page.keyboard.press(plan.keys[i]);
        if (i === Math.floor(plan.keys.length / 2)) {
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${shots}/${vp.name}-5-midway.png` });
          // Reload mid-mission: the save must bring us back to the same turn.
          const before = await page.locator(".hud .stat").first().innerText();
          await page.reload();
          await page.waitForTimeout(800);
          await page.getByRole("button", { name: /Continuer/ }).click();
          await page.waitForTimeout(500);
          const after = await page.locator(".hud .stat").first().innerText();
          if (before !== after) errors.push(`resume mismatch: ${before} vs ${after}`);
        }
      }
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${shots}/${vp.name}-6-debrief.png` });
      const stamp = await page.locator(".stamp").innerText().catch(() => "none");
      console.log(`ghost plan: ${plan.outcome} in ${plan.turns} turns; UI shows: ${stamp}`);
      await page.getByRole("button", { name: /Retour au réseau/ }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/${vp.name}-7-network-after.png`, fullPage: true });
      // Tampering with the save must be refused on load.
      await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem("kuroko.save.v1"));
        s.decisions[0].log = s.decisions[0].log.slice(0, 3);
        localStorage.setItem("kuroko.save.v1", JSON.stringify(s));
      });
      await page.reload();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: /Continuer/ }).click();
      await page.waitForTimeout(500);
      const note = await page.locator(".notice").innerText().catch(() => "");
      console.log(`tampered save: ${note ? "refused" : "ACCEPTED"}`);
      if (!note) errors.push("tampered save accepted");
    } else {
      // Touch: tap a tile next to the agent to walk.
      const box = await page.locator(".stage canvas").boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2 + 40, box.y + box.height / 2);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${shots}/${vp.name}-4-tapped.png` });
    }
    await ctx.close();
  }
  console.log(errors.length ? errors.join("\n") : "no errors");
  await browser.close();
})();
