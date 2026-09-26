// Screenshot the in-game HUD for visual review (before/after styling work).
//   node .claude/skills/run-openfront/hud-shots.mjs <label> [desktop|mobile]
// Produces /tmp/openfront-run/hud-<label>-<viewport>-*.png
import fs from "fs";
import { gotoHome, launch, openSoloModal } from "./driver.mjs";
import {
  attack,
  findExpansionTile,
  findSpawnTile,
  gameState,
  openRadialMenu,
  spawn,
  startSoloGame,
  waitForSpawnPhaseEnd,
  waitForTick,
} from "./game.mjs";

const label = process.argv[2] ?? "shot";
const vpName = process.argv[3] ?? "desktop";
const viewport =
  vpName === "mobile"
    ? { width: 412, height: 860 }
    : { width: 1440, height: 900 };

const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });
const shot = async (page, name) => {
  const p = `${out}/hud-${label}-${vpName}-${name}.png`;
  await page.screenshot({ path: p });
  console.log(`screenshot ${p}`);
};

const { browser, page } = await launch({ viewport, rafIntervalMs: 1500 });
try {
  await gotoHome(page);
  await openSoloModal(page);
  await startSoloGame(page, {
    bots: 30,
    instantBuild: true,
    infiniteGold: true,
  });
  console.log("game ready");
  const tile = await spawn(page, await findSpawnTile(page));
  await waitForSpawnPhaseEnd(page);
  const s0 = await gameState(page);
  await waitForTick(page, s0.ticks + 40);
  const exp = await findExpansionTile(page, tile);
  if (exp) await attack(page, exp.x, exp.y);
  const s1 = await gameState(page);
  await waitForTick(page, s1.ticks + 8);
  await shot(page, "1-main");

  // Aim mode on, to see the toggle's active state.
  await page.evaluate(() => {
    const cp = document.querySelector("control-panel");
    cp.querySelector('img[src*="TargetIconWhite"]')?.closest("button")?.click();
  });
  await page.waitForTimeout(400);
  console.log(
    "aim state:",
    JSON.stringify(
      await page.evaluate(() => {
        const cp = document.querySelector("control-panel");
        const btns = [...cp.querySelectorAll("button")].filter((b) =>
          b.querySelector('img[src*="TargetIconWhite"]'),
        );
        return {
          mode: cp.uiState.directionalAimMode,
          buttons: btns.map((b) => {
            const cs = getComputedStyle(b);
            return {
              visible: b.offsetParent !== null,
              cls: b.className.replace(/\s+/g, " ").trim(),
              border: cs.borderColor,
              bg: cs.backgroundColor,
            };
          }),
        };
      }),
    ),
  );
  await shot(page, "2-aim-on");
  await page.evaluate(() => {
    const cp = document.querySelector("control-panel");
    cp.querySelector('img[src*="TargetIconWhite"]')?.closest("button")?.click();
  });

  const opened = await openRadialMenu(page).catch(() => false);
  console.log("radial menu opened:", opened);
  await page.waitForTimeout(600);
  await shot(page, "3-radial");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, viewport.height / 2); // dismiss radial menu
  await page.waitForTimeout(400);

  // Settings pop-up (gear in the top-right bar)
  await page.evaluate(() => {
    document
      .querySelector('game-right-sidebar img[alt="settings"]')
      ?.closest("div")
      ?.click();
  });
  await page.waitForTimeout(800);
  await shot(page, "4-settings");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // Player panel for the nearest other nation
  const opened2 = await page.evaluate(async () => {
    const g = document.querySelector("build-menu").game;
    const me = g.myPlayer();
    const other = g
      .playerViews()
      .find((p) => p !== me && p.isAlive() && p.numTilesOwned() > 0);
    if (!other) return false;
    const loc = other.nameLocation();
    const tile = g.ref(Math.round(loc.x), Math.round(loc.y));
    const actions = await me.actions(tile);
    document.querySelector("player-panel").show(actions, tile);
    return true;
  });
  console.log("player panel opened:", opened2);
  await page.waitForTimeout(1200);
  await shot(page, "5-player-panel");
} finally {
  await browser.close();
}
