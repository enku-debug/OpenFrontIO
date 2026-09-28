// In-game check of freehand Aim lines: turn Aim on, press on land outside
// your territory and draw one wavy stroke; the attack should start from
// your nearest border and follow the whole line.
//   node .claude/skills/run-openfront/aim-freehand-demo.mjs
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
  worldToScreen,
} from "./game.mjs";

const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });
const shot = async (page, name) => {
  await page.screenshot({ path: `${out}/freehand-${name}.png` });
  console.log(`screenshot ${out}/freehand-${name}.png`);
};

const { browser, page } = await launch({
  viewport: { width: 1440, height: 900 },
  rafIntervalMs: 1500,
});
try {
  await gotoHome(page);
  await openSoloModal(page);
  await startSoloGame(page, { bots: 0, instantBuild: true, infiniteGold: true });
  const spawnTile = await spawn(page, await findSpawnTile(page));
  await waitForSpawnPhaseEnd(page);
  let s = await gameState(page);
  await waitForTick(page, s.ticks + 15);

  // A wave, starting 10 tiles past the edge of your land, in whichever of
  // the four directions has the most land along it.
  const plan = await page.evaluate(
    ([fx, fy]) => {
      const g = document.querySelector("build-menu").game;
      const me = g.myPlayer();
      const loc = me.nameLocation();
      const c =
        loc && loc.size > 0
          ? { x: Math.round(loc.x), y: Math.round(loc.y) }
          : { x: fx, y: fy };
      const mine = me.smallID();
      let best = null;
      for (const [ux, uy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        // Edge of own land along this direction.
        let edge = 0;
        while (
          edge < 60 &&
          g.isValidCoord(c.x + ux * edge, c.y + uy * edge) &&
          g.ownerID(g.ref(c.x + ux * edge, c.y + uy * edge)) === mine
        )
          edge++;
        const pts = [];
        let land = 0;
        for (let t = 0; t <= 64; t += 2) {
          const along = edge + 10 + t;
          const side = Math.round(13 * Math.sin((t / 64) * 2 * Math.PI));
          const x = c.x + ux * along - uy * side;
          const y = c.y + uy * along + ux * side;
          if (!g.isValidCoord(x, y)) {
            pts.length = 0;
            break;
          }
          pts.push({ x, y });
          if (g.isLand(g.ref(x, y)) && !g.hasOwner(g.ref(x, y))) land++;
        }
        if (pts.length && (best === null || land > best.land))
          best = { pts, land, c, edge };
      }
      return best;
    },
    [spawnTile.x, spawnTile.y],
  );
  console.log(
    "plan",
    JSON.stringify({ land: plan.land, of: plan.pts.length, edge: plan.edge }),
  );
  const pts = plan.pts;
  const mid = pts[Math.floor(pts.length / 2)];
  await page.evaluate(() =>
    document.querySelector("build-menu").transformHandler.clearTarget(),
  );
  await panTo(page, (plan.c.x + mid.x) / 2, (plan.c.y + mid.y) / 2);

  const box = {
    x0: Math.min(plan.c.x, ...pts.map((p) => p.x)) - 30,
    x1: Math.max(plan.c.x, ...pts.map((p) => p.x)) + 30,
    y0: Math.min(plan.c.y, ...pts.map((p) => p.y)) - 30,
    y1: Math.max(plan.c.y, ...pts.map((p) => p.y)) + 30,
  };
  const myTiles = () =>
    page.evaluate((b) => {
      const g = document.querySelector("build-menu").game;
      const mine = g.myPlayer().smallID();
      const o = [];
      for (let y = b.y0; y <= b.y1; y++)
        for (let x = b.x0; x <= b.x1; x++)
          if (g.isValidCoord(x, y) && g.ownerID(g.ref(x, y)) === mine)
            o.push([x, y]);
      return o;
    }, box);
  const before = new Set((await myTiles()).map(([x, y]) => `${x},${y}`));

  await page.evaluate(() => {
    const cp = document.querySelector("control-panel");
    [...cp.querySelectorAll("button")]
      .find(
        (b) => b.offsetParent && b.querySelector('img[src*="TargetIconWhite"]'),
      )
      .click();
  });
  await page.waitForTimeout(300);

  // One continuous stroke through the wave, in small steps like a hand.
  const scr = [];
  for (const p of pts) scr.push(await worldToScreen(page, p.x + 0.5, p.y + 0.5));
  await page.mouse.move(scr[0].x, scr[0].y);
  await page.mouse.down();
  for (let i = 0; i + 1 < scr.length; i++) {
    for (let k = 1; k <= 2; k++) {
      await page.mouse.move(
        scr[i].x + ((scr[i + 1].x - scr[i].x) * k) / 2,
        scr[i].y + ((scr[i + 1].y - scr[i].y) * k) / 2,
      );
      await page.waitForTimeout(10);
    }
  }
  await page.waitForTimeout(400);
  const preview = await page.evaluate(() => ({
    label: document.getElementById("direction-aim-drag-label")?.textContent,
    points: document
      .querySelector("#direction-aim-drag-svg polyline:nth-of-type(2)")
      ?.getAttribute("points")
      ?.split(" ").length,
  }));
  console.log("preview while dragging:", JSON.stringify(preview));
  await shot(page, "1-drawing");
  await page.mouse.up();
  s = await gameState(page);
  await waitForTick(page, s.ticks + 6);
  const attacks = await page.evaluate(() =>
    document
      .querySelector("build-menu")
      .game.myPlayer()
      .outgoingAttacks()
      .map((a) => Math.round(a.troops)),
  );
  console.log("attacks after release:", JSON.stringify(attacks));

  // Two more waves so it can reach the end of the line.
  for (let w = 2; w <= 3; w++) {
    await page.evaluate(() =>
      document.getElementById("direction-aim-live-label").click(),
    );
    s = await gameState(page);
    await waitForTick(page, s.ticks + 6, 300_000);
  }
  s = await gameState(page);
  await waitForTick(page, s.ticks + 60, 400_000);
  await page.waitForTimeout(3500);
  await shot(page, "2-after");

  // Distance of every newly taken tile from the drawn line (plus the leg
  // from your land to its start).
  const line = [plan.c, ...pts];
  const gained = (await myTiles()).filter(([x, y]) => !before.has(`${x},${y}`));
  const dist = ([x, y]) => {
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const last = i + 2 === line.length;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1);
      t = Math.max(0, last ? t : Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
    }
    return best;
  };
  const ds = gained.map(dist);
  const end = pts[pts.length - 1];
  const nearEnd = gained.filter(
    ([x, y]) => Math.hypot(x - end.x, y - end.y) <= 8,
  ).length;
  console.log(
    "SUMMARY",
    JSON.stringify({
      previewPoints: preview.points,
      gained: gained.length,
      maxDistFromLine: +Math.max(...ds).toFixed(1),
      over10: ds.filter((d) => d > 10).length,
      tilesNearLineEnd: nearEnd,
    }),
  );
} finally {
  await browser.close();
}
