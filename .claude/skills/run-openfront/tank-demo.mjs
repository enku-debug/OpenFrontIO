// In-game check of tanks: build a Tank Factory with its hotkey, buy tanks
// from the control panel, switch on tank mode and attack with tanks.
//   node .claude/skills/run-openfront/tank-demo.mjs
import fs from "fs";
import { gotoHome, launch, openSoloModal } from "./driver.mjs";
import {
  clickWorld,
  findExpansionTile,
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
const shot = async (page, name, clip) => {
  await page.screenshot({ path: `${out}/tank-${name}.png`, clip });
  console.log(`screenshot ${out}/tank-${name}.png`);
};
const ticksPass = async (page, n) => {
  const s = await gameState(page);
  await waitForTick(page, s.ticks + n, 300_000);
};
const mine = (page) =>
  page.evaluate(() => {
    const g = document.querySelector("build-menu").game;
    const me = g.myPlayer();
    return {
      tanks: me.tanks(),
      deployed: me.tanksDeployed(),
      max: g.config().maxTanks(me),
      troops: Math.round(me.troops()),
      factories: me.units("Tank Factory").length,
      attacks: me
        .outgoingAttacks()
        .map((a) => ({ troops: +a.troops.toFixed(2), armored: !!a.armored })),
    };
  });
const clickButton = (page, text) =>
  page.evaluate((t) => {
    const cp = document.querySelector("control-panel");
    const b = [...cp.querySelectorAll("button")].find(
      (x) => x.offsetParent && x.textContent.trim() === t,
    );
    if (!b) return false;
    b.click();
    return true;
  }, text);

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
  await ticksPass(page, 10);

  // Tank Factory via its hotkey (V) and a click on our land.
  const home = await page.evaluate(
    ([fx, fy]) => {
      const loc = document
        .querySelector("build-menu")
        .game.myPlayer()
        .nameLocation();
      return loc && loc.size > 0
        ? { x: Math.round(loc.x), y: Math.round(loc.y) }
        : { x: fx, y: fy };
    },
    [spawnTile.x, spawnTile.y],
  );
  await page.evaluate(() =>
    document.querySelector("build-menu").transformHandler.clearTarget(),
  );
  await panTo(page, home.x, home.y);
  const hs = await worldToScreen(page, home.x + 0.5, home.y + 0.5);
  await page.mouse.move(hs.x, hs.y);
  await page.keyboard.press("KeyV");
  await page.waitForTimeout(600);
  await page.mouse.click(hs.x, hs.y);
  await ticksPass(page, 8);
  console.log("after build:", JSON.stringify(await mine(page)));

  // Buy 3 × 10 tanks.
  for (let i = 0; i < 3; i++) {
    console.log("buy clicked:", await clickButton(page, "+10"));
    await ticksPass(page, 3);
  }
  console.log("after buying:", JSON.stringify(await mine(page)));
  await page.waitForTimeout(1700);
  await shot(page, "1-panel", { x: 440, y: 740, width: 560, height: 160 });

  // Tank mode on, then attack the nearest wilderness with a click.
  console.log("tank mode clicked:", await clickButton(page, "Tanks"));
  await page.evaluate(() => {
    document.querySelector("control-panel").uiState.attackRatio = 0.5;
  });
  await page.waitForTimeout(300);
  const exp = await findExpansionTile(page, home);
  await clickWorld(page, exp.x, exp.y);
  await ticksPass(page, 4);
  console.log("after tank attack:", JSON.stringify(await mine(page)));
  await page.waitForTimeout(1700);
  await shot(page, "2-attacking");
  await ticksPass(page, 40);
  console.log("later:", JSON.stringify(await mine(page)));
  await page.waitForTimeout(1700);
  await shot(page, "3-after");
} finally {
  await browser.close();
}
