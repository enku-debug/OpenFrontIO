/**
 * Landlocked players (no owned tile touches the ocean) earn
 * Config.landlockedTrainGoldBonus times the train gold.
 */
import { PlayerInfo, PlayerType } from "../src/core/game/Game";
import { landlockedTrainGold } from "../src/core/game/TrainStation";
import { setup } from "./util/Setup";

describe("Landlocked", () => {
  it("is set by ocean contact, and multiplies train gold", async () => {
    const game = await setup("half_land_half_ocean", {}, [
      new PlayerInfo("p", PlayerType.Human, null, "p"),
    ]);
    const p = game.player("p");
    const map = game.map();

    // An inland tile: land with no ocean within 3 tiles.
    let inland = -1;
    let shore = -1;
    map.forEachTile((t) => {
      if (shore === -1 && map.isLand(t) && map.isOceanShore(t)) shore = t;
      if (inland !== -1 || !map.isLand(t)) return;
      const x = map.x(t);
      const y = map.y(t);
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (!map.isValidCoord(x + dx, y + dy)) return;
          if (map.isOcean(map.ref(x + dx, y + dy))) return;
        }
      }
      inland = t;
    });
    expect(inland).not.toBe(-1);
    expect(shore).not.toBe(-1);

    expect(p.isLandlocked()).toBe(false); // owns nothing yet
    p.conquer(inland);
    expect(p.isLandlocked()).toBe(true);
    expect(landlockedTrainGold(game, p, 10_000n)).toBe(17_000n);

    p.conquer(shore);
    expect(p.isLandlocked()).toBe(false);
    expect(landlockedTrainGold(game, p, 10_000n)).toBe(10_000n);
  });
});
