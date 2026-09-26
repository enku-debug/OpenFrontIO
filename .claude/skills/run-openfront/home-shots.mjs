// Screenshot the home page (desktop + phone) and report the tab title.
//   node .claude/skills/run-openfront/home-shots.mjs <label>
import fs from "fs";
import { gotoHome, launch } from "./driver.mjs";

const label = process.argv[2] ?? "home";
const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 412, height: 860 }],
]) {
  const { browser, page } = await launch({ viewport });
  try {
    await gotoHome(page);
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => ({
      title: document.title,
      logos: [...document.querySelectorAll("img")]
        .filter((i) => /Logo\.svg/.test(i.src) && i.offsetParent !== null)
        .map((i) => ({
          src: i.src.replace(location.origin, ""),
          loaded: i.complete && i.naturalWidth > 0,
          w: Math.round(i.getBoundingClientRect().width),
          h: Math.round(i.getBoundingClientRect().height),
        })),
    }));
    console.log(name, JSON.stringify(info));
    const p = `${out}/home-${label}-${name}.png`;
    await page.screenshot({ path: p });
    console.log(`screenshot ${p}`);
  } finally {
    await browser.close();
  }
}
