// In-game check of bent Aim paths: draw one stroke with two turns and
// verify the attack follows it.
//   node .claude/skills/run-openfront/aim-bent-demo.mjs
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
  await page.screenshot({ path: `${out}/bent-${name}.png` });
  console.log(`screenshot ${out}/bent-${name}.png`);
};

const { browser, page } = await launch({
  viewport: { width: 1440, height: 900 },
  rafIntervalMs: 1500,
});
try {
  await gotoHome(page);
  await openSoloModal(page);
  await startSoloGame(page, {
    bots: 0,
    instantBuild: true,
    infiniteGold: true,
  });
  const spawnTile = await spawn(page, await findSpawnTile(page));
  await waitForSpawnPhaseEnd(page);
  let s = await gameState(page);
  await waitForTick(page, s.ticks + 15);

  const c = await page.evaluate(
    ([fx, fy]) => {
      const g = document.querySelector("build-menu").game;
      const loc = g.myPlayer().nameLocation();
      return loc && loc.size > 0
        ? { x: Math.round(loc.x), y: Math.round(loc.y) }
        : { x: fx, y: fy };
    },
    [spawnTile.x, spawnTile.y],
  );
  // Right, then up, then right again (world tiles).
  const corners = [
    { x: c.x, y: c.y },
    { x: c.x + 28, y: c.y },
    { x: c.x + 36, y: c.y - 26 },
    { x: c.x + 62, y: c.y - 30 },
  ];
  await page.evaluate(() =>
    document.querySelector("build-menu").transformHandler.clearTarget(),
  );
  await panTo(page, c.x + 31, c.y - 14);
  const scr = [];
  for (const p of corners) {
    const q = await worldToScreen(page, p.x + 0.5, p.y + 0.5);
    if (!q) throw new Error("corner off-screen");
    scr.push(q);
  }
  console.log("corners world", JSON.stringify(corners));

  // Box around the path for the before/after tile scan.
  const box = {
    x0: c.x - 40,
    x1: c.x + 110,
    y0: c.y - 80,
    y1: c.y + 50,
  };
  const myTiles = () =>
    page.evaluate((b) => {
      const g = document.querySelector("build-menu").game;
      const mine = g.myPlayer().smallID();
      const outT = [];
      for (let y = b.y0; y <= b.y1; y++)
        for (let x = b.x0; x <= b.x1; x++)
          if (g.isValidCoord(x, y) && g.ownerID(g.ref(x, y)) === mine)
            outT.push([x, y]);
      return outT;
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

  // One continuous stroke through the corners.
  await page.mouse.move(scr[0].x, scr[0].y);
  await page.mouse.down();
  for (let i = 0; i + 1 < scr.length; i++) {
    const a = scr[i];
    const b = scr[i + 1];
    const steps = 10;
    for (let k = 1; k <= steps; k++) {
      await page.mouse.move(
        a.x + ((b.x - a.x) * k) / steps,
        a.y + ((b.y - a.y) * k) / steps,
      );
      await page.waitForTimeout(25);
    }
  }
  await page.waitForTimeout(400);
  const preview = await page.evaluate(() => ({
    label: document.getElementById("direction-aim-drag-label")?.textContent,
    points: document
      .querySelector("#direction-aim-drag-svg polyline:nth-of-type(2)")
      ?.getAttribute("points"),
  }));
  console.log("preview while dragging:", JSON.stringify(preview));
  await shot(page, "1-drawing");
  await page.mouse.up();
  s = await gameState(page);
  await waitForTick(page, s.ticks + 6);

  const attacks = () =>
    page.evaluate(() => {
      const g = document.querySelector("build-menu").game;
      const lab = document.getElementById("direction-aim-live-label");
      return {
        attacks: g
          .myPlayer()
          .outgoingAttacks()
          .map((a) => Math.round(a.troops)),
        myTroops: Math.round(g.myPlayer().troops()),
        badgeShown: lab?.style.display !== "none",
      };
    });
  console.log("after wave 1:", JSON.stringify(await attacks()));

  // Two more waves along the same bent path.
  for (let w = 2; w <= 3; w++) {
    await page.evaluate(() =>
      document.getElementById("direction-aim-live-label").click(),
    );
    s = await gameState(page);
    await waitForTick(page, s.ticks + 6);
    console.log(`after wave ${w}:`, JSON.stringify(await attacks()));
  }
  s = await gameState(page);
  await waitForTick(page, s.ticks + 70);
  await page.waitForTimeout(3500);
  const badge = await page.evaluate(
    () => document.getElementById("direction-aim-live-label")?.textContent,
  );
  await shot(page, "2-after");

  // Distance of every newly taken tile from the drawn polyline.
  const gained = (await myTiles()).filter(([x, y]) => !before.has(`${x},${y}`));
  const dist = ([x, y]) => {
    let best = Infinity;
    for (let i = 0; i + 1 < corners.length; i++) {
      const a = corners[i];
      const b = corners[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const last = i + 2 === corners.length;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy);
      t = Math.max(0, last ? t : Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
    }
    return best;
  };
  const ds = gained.map(dist);
  const nearLeg3 = gained.filter(
    ([x, y]) => x > c.x + 40 && y < c.y - 18,
  ).length;
  console.log(
    "SUMMARY",
    JSON.stringify({
      badge,
      gained: gained.length,
      maxDistFromPath: +Math.max(...ds).toFixed(1),
      tilesOnThirdLeg: nearLeg3,
      tilesStraightPastFirstBend: gained.filter(
        ([x, y]) => x > c.x + 46 && Math.abs(y - c.y) < 6,
      ).length,
    }),
  );
} finally {
  await browser.close();
}
