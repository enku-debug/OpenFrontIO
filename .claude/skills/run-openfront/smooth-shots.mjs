// Before/after screenshots of smooth map edges (settings.mapOverlay
// .smoothEdges): zooms onto a nation's coast and borders, shoots with
// smoothing on, then flips the setting off live and shoots again.
//   node .claude/skills/run-openfront/smooth-shots.mjs
// Produces /tmp/openfront-run/smooth-{on,off}-z<zoom>.png
import fs from "fs";
import { gotoHome, launch, openSoloModal } from "./driver.mjs";
import {
  findSpawnTile,
  gameState,
  panTo,
  spawn,
  startSoloGame,
  waitForSpawnPhaseEnd,
  waitForTick,
} from "./game.mjs";

const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });

const { browser, page } = await launch({
  viewport: { width: 1440, height: 900 },
  rafIntervalMs: 1500,
});
const glErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/shader|glsl|webgl|GL_INVALID|compile/i.test(t)) glErrors.push(t);
});
try {
  await gotoHome(page);
  await openSoloModal(page);
  await startSoloGame(page, { bots: 30, instantBuild: true, infiniteGold: true });
  await spawn(page, await findSpawnTile(page));
  await waitForSpawnPhaseEnd(page);
  let s = await gameState(page);
  await waitForTick(page, s.ticks + 40, 300_000);

  // A coastal border tile of the biggest nation other than me.
  const spot = await page.evaluate(() => {
    const g = document.querySelector("build-menu").game;
    const me = g.myPlayer()?.smallID();
    const w = g.width();
    const h = g.height();
    const count = new Map();
    for (let y = 0; y < h; y += 3)
      for (let x = 0; x < w; x += 3) {
        const o = g.ownerID(g.ref(x, y));
        if (o !== 0 && o !== me) count.set(o, (count.get(o) ?? 0) + 1);
      }
    const big = [...count.entries()].sort((a, b) => b[1] - a[1]);
    for (const [owner] of big) {
      for (let y = 2; y < h - 2; y++)
        for (let x = 2; x < w - 2; x++) {
          const t = g.ref(x, y);
          if (g.ownerID(t) !== owner) continue;
          let water = 0;
          let other = 0;
          for (let dy = -6; dy <= 6; dy++)
            for (let dx = -6; dx <= 6; dx++) {
              if (!g.isValidCoord(x + dx, y + dy)) continue;
              const n = g.ref(x + dx, y + dy);
              if (g.isWater(n)) water++;
              else if (g.ownerID(n) !== owner) other++;
            }
          if (water > 20 && other > 15) return { x, y, owner };
        }
    }
    return null;
  });
  if (spot === null) throw new Error("no coastal border found");
  console.log("spot", JSON.stringify(spot));

  const setZoom = (scale) =>
    page.evaluate((sc) => {
      const t = document.querySelector("build-menu").transformHandler;
      t.clearTarget();
      t.scale = sc;
    }, scale);
  const setSmooth = (on) =>
    page.evaluate((v) => {
      const el = document.createElement("graphics-advanced-settings");
      if (el.currentSmoothEdges() !== v) el.onToggleSmoothEdges();
      return el.currentSmoothEdges();
    }, on);

  for (const zoom of [12, 4]) {
    for (const on of [true, false]) {
      console.log("smooth now", await setSmooth(on));
      await setZoom(zoom);
      await panTo(page, spot.x, spot.y);
      await page.waitForTimeout(3500);
      const p = `${out}/smooth-${on ? "on" : "off"}-z${zoom}.png`;
      await page.screenshot({ path: p });
      console.log("screenshot", p);
    }
  }
  await setSmooth(true);
  console.log("GL messages:", JSON.stringify(glErrors.slice(0, 10)));
} finally {
  await browser.close();
}
