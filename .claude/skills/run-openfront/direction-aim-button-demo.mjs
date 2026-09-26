// Smoke test for the new "Aim & attack" button + drag-to-draw-arrow feature:
// toggle the button, drag an arrow across the canvas, release, and confirm
// an attack intent actually fired (troops committed to an outgoing attack).
import fs from "fs";
import {
  attack,
  findSpawnTile,
  gameState,
  spawn,
  startSoloGame,
  waitForSpawnPhaseEnd,
  waitForTick,
  worldToScreen,
} from "./game.mjs";
import { gotoHome, launch, openSoloModal } from "./driver.mjs";

const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });
const shot = (page, name) =>
  page.screenshot({ path: `${out}/${name}.png` }).then(() => {
    const kb = Math.round(fs.statSync(`${out}/${name}.png`).size / 1024);
    console.log(`screenshot ${out}/${name}.png (${kb} KB)`);
  });

const { browser, page } = await launch({ rafIntervalMs: 3000 });
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

try {
  console.log("1. home + solo modal");
  await gotoHome(page);
  await openSoloModal(page);

  console.log("2. starting solo game");
  await startSoloGame(page, { bots: 0, instantBuild: true, infiniteGold: true });

  console.log("3. spawning...");
  const tile = await spawn(page, await findSpawnTile(page));
  console.log(`   spawned at (${tile.x},${tile.y})`);
  await waitForSpawnPhaseEnd(page);

  const s0 = await gameState(page);
  await waitForTick(page, s0.ticks + 15);

  await shot(page, "aimbtn-1-before-toggle");

  console.log("4. checking the Aim button is present and toggling it on");
  const before = await page.evaluate(() => {
    const cp = document.querySelector("control-panel");
    const img = cp.querySelector('img[src*="TargetIconWhite"]');
    const btn = img?.closest("button") ?? null;
    return {
      buttonFound: btn !== null,
      uiStateBefore: cp.uiState.directionalAimMode,
    };
  });
  console.log("   ", JSON.stringify(before));
  if (!before.buttonFound) throw new Error("Aim button not found in control-panel DOM");

  await page.evaluate(() => {
    const cp = document.querySelector("control-panel");
    const img = cp.querySelector('img[src*="TargetIconWhite"]');
    img.closest("button").click();
  });
  await page.waitForTimeout(200);

  const afterToggle = await page.evaluate(
    () => document.querySelector("control-panel").uiState.directionalAimMode,
  );
  console.log("   uiState.directionalAimMode after click:", afterToggle);
  if (afterToggle !== true) throw new Error("toggle did not flip uiState.directionalAimMode");

  await shot(page, "aimbtn-2-active");

  console.log("5. dragging an arrow across the canvas");
  // Pick a start point near screen center (clear of HUD) and drag toward an
  // unowned tile further out, similar to findExpansionTile's radius search.
  const dragTarget = await page.evaluate(() => {
    const bm = document.querySelector("build-menu");
    const g = bm.game;
    const me = g.myPlayer();
    const loc = me.nameLocation();
    const cx = Math.round(loc.x);
    const cy = Math.round(loc.y);
    for (let r = 2; r < 150; r += 2) {
      for (const [dx, dy] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        const x = cx + dx;
        const y = cy + dy;
        if (!g.isValidCoord(x, y)) continue;
        const ref = g.ref(x, y);
        if (g.isLand(ref) && g.hasOwner(ref) && g.owner(ref).id() !== me.id()) {
          return { x, y };
        }
      }
    }
    return null;
  });
  console.log("   drag target (enemy-owned tile):", JSON.stringify(dragTarget));
  if (dragTarget === null) {
    console.log("   no enemy-owned tile found nearby (0 bots?) — dragging toward unowned land instead");
  }
  const target = dragTarget ?? { x: tile.x + 40, y: tile.y };

  const startScreen = await worldToScreen(page, tile.x, tile.y);
  const endScreen = await worldToScreen(page, target.x, target.y);
  console.log("   startScreen", startScreen, "endScreen", endScreen);
  if (startScreen === null || endScreen === null) {
    throw new Error("start or end point off-screen; adjust camera first");
  }

  await page.mouse.move(startScreen.x, startScreen.y);
  await page.mouse.down();
  // Multiple intermediate moves so InputHandler sees a real drag distance.
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const x = startScreen.x + ((endScreen.x - startScreen.x) * i) / steps;
    const y = startScreen.y + ((endScreen.y - startScreen.y) * i) / steps;
    await page.mouse.move(x, y);
    await page.waitForTimeout(30);
  }
  await shot(page, "aimbtn-3-mid-drag");
  const arrowVisible = await page.evaluate(() => {
    const line = document.getElementById("direction-aim-line");
    return line !== null && line.style.display !== "none";
  });
  console.log("   arrow overlay visible mid-drag:", arrowVisible);

  const troopsBefore = await page.evaluate(
    () => document.querySelector("build-menu").game.myPlayer().troops(),
  );
  await page.mouse.up();
  await page.waitForTimeout(500);

  const arrowHiddenAfter = await page.evaluate(() => {
    const line = document.getElementById("direction-aim-line");
    return line === null || line.style.display === "none";
  });
  console.log("   arrow overlay hidden after release:", arrowHiddenAfter);

  const s1 = await gameState(page);
  await waitForTick(page, s1.ticks + 10);

  const after = await page.evaluate(() => {
    const me = document.querySelector("build-menu").game.myPlayer();
    return {
      troops: me.troops(),
      outgoingAttacks: me.outgoingAttacks().length,
    };
  });
  console.log("   troops before drag-release:", troopsBefore);
  console.log("   after:", JSON.stringify(after));

  await shot(page, "aimbtn-4-after-release");

  console.log("\nSUMMARY");
  console.log("Aim button found:", before.buttonFound);
  console.log("Toggle worked:", afterToggle === true);
  console.log("Arrow rendered during drag:", arrowVisible);
  console.log("Arrow cleared after release:", arrowHiddenAfter);
  console.log(
    "Attack fired (outgoingAttacks>0 or troops dropped):",
    after.outgoingAttacks > 0 || after.troops < troopsBefore,
  );
  console.log("Console errors seen:", consoleErrors.length);
  if (consoleErrors.length > 0) {
    console.log(consoleErrors.slice(0, 10).join("\n"));
  }
} finally {
  await browser.close();
}
