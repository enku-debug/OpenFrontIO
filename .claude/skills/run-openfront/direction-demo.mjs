// Live-game demo of directed attacks: click far in one direction and verify
// territory grows noticeably that way rather than growing evenly all around
// the border (the old, undirected default).
import fs from "fs";
import {
  attack,
  findSpawnTile,
  gameState,
  spawn,
  waitForSpawnPhaseEnd,
  waitForTick,
} from "./game.mjs";
import { gotoHome, launch, openSoloModal } from "./driver.mjs";

const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });
const shot = (page, name) =>
  page.screenshot({ path: `${out}/${name}.png` }).then(() => {
    const kb = Math.round(fs.statSync(`${out}/${name}.png`).size / 1024);
    console.log(`screenshot ${out}/${name}.png (${kb} KB)`);
  });

// Bounding-box "reach" of my territory in each of the 4 cardinal directions
// from the spawn tile, in tiles.
async function reach(page, spawnTile) {
  return await page.evaluate(
    ([sx, sy]) => {
      const g = document.querySelector("build-menu").game;
      const me = g.myPlayer();
      let north = 0,
        south = 0,
        east = 0,
        west = 0;
      for (const t of me.tiles()) {
        const x = g.x(t);
        const y = g.y(t);
        north = Math.max(north, sy - y);
        south = Math.max(south, y - sy);
        east = Math.max(east, x - sx);
        west = Math.max(west, sx - x);
      }
      return { north, south, east, west, tiles: me.numTilesOwned() };
    },
    [spawnTile.x, spawnTile.y],
  );
}

const { browser, page } = await launch({ rafIntervalMs: 3000 });
try {
  console.log("1. home + solo modal");
  await gotoHome(page);
  await openSoloModal(page);

  console.log("2. starting solo game (0 bots, instant build, infinite gold)");
  const modalState = await page.evaluate(() => {
    const modal = document.querySelector("single-player-modal");
    if (!modal) return { found: false };
    modal.bots = 0;
    modal.instantBuild = true;
    modal.infiniteGold = true;
    return { found: true, bots: modal.bots };
  });
  console.log("   modal state:", JSON.stringify(modalState));
  await page.waitForTimeout(300);
  await shot(page, "direction-modal-before-start");
  const { startSoloGame } = await import("./game.mjs");
  await startSoloGame(page);

  console.log("3. spawning…");
  const tile = await spawn(page, await findSpawnTile(page));
  console.log(`   spawned at (${tile.x},${tile.y})`);
  await waitForSpawnPhaseEnd(page);
  await shot(page, "direction-spawned");

  console.log("4. letting territory settle a moment…");
  let s0 = await gameState(page);
  await waitForTick(page, s0.ticks + 20);
  const before = await reach(page, tile);
  console.log("   reach before:", JSON.stringify(before));

  console.log("5. attacking far NORTH of spawn…");
  const north = { x: tile.x, y: Math.max(0, tile.y - 60) };
  await attack(page, north.x, north.y);
  const s1 = await gameState(page);
  await waitForTick(page, s1.ticks + 30);
  const afterNorth = await reach(page, tile);
  console.log("   reach after north-click:", JSON.stringify(afterNorth));
  await shot(page, "direction-after-north");

  console.log("6. attacking far EAST of spawn…");
  const east = { x: tile.x + 60, y: tile.y };
  await attack(page, east.x, east.y);
  const s2 = await gameState(page);
  await waitForTick(page, s2.ticks + 30);
  const afterEast = await reach(page, tile);
  console.log("   reach after east-click:", JSON.stringify(afterEast));
  await shot(page, "direction-after-east");

  console.log("\nSUMMARY");
  console.log("north reach: ", before.north, "->", afterNorth.north, "->", afterEast.north);
  console.log("east reach:  ", before.east, "->", afterNorth.east, "->", afterEast.east);
} finally {
  await browser.close();
}
