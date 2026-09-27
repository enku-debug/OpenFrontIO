// In-game check of the Aim corridor: draw an arrow, click it twice more,
// and verify only the corridor advances while the troops stack.
//   node .claude/skills/run-openfront/aim-corridor-demo.mjs
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
  await page.screenshot({ path: `${out}/aim-${name}.png` });
  console.log(`screenshot ${out}/aim-${name}.png`);
};
// My tiles within a box around the arrow (the client keeps no per-player
// tile list, so scan owners directly).
let BOX = null;
const myTiles = (page) =>
  page.evaluate((box) => {
    const g = document.querySelector("build-menu").game;
    const mine = g.myPlayer().smallID();
    const out = [];
    for (let y = box.y0; y <= box.y1; y++)
      for (let x = box.x0; x <= box.x1; x++) {
        if (!g.isValidCoord(x, y)) continue;
        if (g.ownerID(g.ref(x, y)) === mine) out.push([x, y]);
      }
    return out;
  }, BOX);
const attackInfo = (page) =>
  page.evaluate(() => {
    const g = document.querySelector("build-menu").game;
    return g
      .myPlayer()
      .outgoingAttacks()
      .map((a) => ({ target: a.targetID, troops: Math.round(a.troops) }));
  });

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

  // Arrow from the middle of my land, ~45 tiles out to the east-north-east.
  const center = await page.evaluate(
    ([fx, fy]) => {
      const g = document.querySelector("build-menu").game;
      const loc = g.myPlayer().nameLocation();
      return loc && loc.size > 0
        ? { x: Math.round(loc.x), y: Math.round(loc.y) }
        : { x: fx, y: fy };
    },
    [spawnTile.x, spawnTile.y],
  );
  const tip = { x: center.x + 45, y: center.y - 15 };
  await page.evaluate(() =>
    document.querySelector("build-menu").transformHandler.clearTarget(),
  );
  await panTo(page, center.x + 20, center.y - 7);
  const a = await worldToScreen(page, center.x + 0.5, center.y + 0.5);
  const b = await worldToScreen(page, tip.x + 0.5, tip.y + 0.5);
  console.log("arrow world", center, "->", tip, "screen", a, "->", b);
  if (!a || !b) throw new Error("arrow endpoints off-screen");

  BOX = {
    x0: Math.min(center.x, tip.x) - 90,
    x1: Math.max(center.x, tip.x) + 90,
    y0: Math.min(center.y, tip.y) - 90,
    y1: Math.max(center.y, tip.y) + 90,
  };
  const before = new Set((await myTiles(page)).map(([x, y]) => `${x},${y}`));

  // Aim mode on (desktop button).
  await page.evaluate(() => {
    const cp = document.querySelector("control-panel");
    [...cp.querySelectorAll("button")]
      .find(
        (b) => b.offsetParent && b.querySelector('img[src*="TargetIconWhite"]'),
      )
      .click();
  });
  await page.waitForTimeout(300);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      a.x + ((b.x - a.x) * i) / 8,
      a.y + ((b.y - a.y) * i) / 8,
    );
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(400);
  const dragLabel = await page.evaluate(
    () => document.getElementById("direction-aim-drag-label")?.textContent,
  );
  console.log("label while dragging:", dragLabel);
  await shot(page, "1-dragging");
  await page.mouse.up();
  {
    const t = await gameState(page);
    await waitForTick(page, t.ticks + 6);
  }
  console.log("attacks after wave 1:", JSON.stringify(await attackInfo(page)));
  await shot(page, "2-released");

  s = await gameState(page);
  await waitForTick(page, s.ticks + 12);
  const w1 = await attackInfo(page);

  // Click the live arrow twice more: waves 2 and 3.
  for (let wave = 2; wave <= 3; wave++) {
    // Dispatch the click on the arrow's badge directly: in this throttled
    // headless browser the arrow is re-projected only every 1.5 s, so a
    // coordinate click can land on stale geometry while the camera moves.
    await page.evaluate(() =>
      document.getElementById("direction-aim-live-label").click(),
    );
    // Wait for the intent to reach the simulation (a few game ticks).
    const t = await gameState(page);
    await waitForTick(page, t.ticks + 6);
    console.log(
      `attacks after wave ${wave}:`,
      JSON.stringify(await attackInfo(page)),
    );
  }
  await page.waitForTimeout(3500); // let the throttled frame loop redraw the badge
  const badge = await page.evaluate(
    () => document.getElementById("direction-aim-live-label")?.textContent,
  );
  console.log("live arrow badge:", badge);
  await shot(page, "3-three-waves");

  s = await gameState(page);
  await waitForTick(page, s.ticks + 40);
  await shot(page, "4-spearhead");

  // Every newly taken tile should sit in the corridor around the arrow.
  const snapped = await page.evaluate(() => {
    // what the client actually sent (start snapped into own land)
    return null;
  });
  void snapped;
  const dx = tip.x - center.x;
  const dy = tip.y - center.y;
  const len = Math.hypot(dx, dy);
  const gained = (await myTiles(page)).filter(
    ([x, y]) => !before.has(`${x},${y}`),
  );
  const perp = gained.map(
    ([x, y]) => Math.abs((x - center.x) * dy - (y - center.y) * dx) / len,
  );
  const along = gained.map(
    ([x, y]) => ((x - center.x) * dx + (y - center.y) * dy) / len,
  );
  console.log(
    "gained tiles:",
    gained.length,
    "max perpendicular distance from arrow line:",
    Math.max(...perp).toFixed(1),
    "max distance along arrow:",
    Math.max(...along).toFixed(1),
    "(arrow length",
    len.toFixed(1) + ")",
  );
  console.log("SUMMARY", JSON.stringify({ w1, badge, dragLabel }));
} finally {
  await browser.close();
}
