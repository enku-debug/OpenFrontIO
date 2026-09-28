/**
 * Directed attacks: the player can now aim an attack at a chosen tile
 * (AttackExecution's `directionTile`), which biases the conquest ORDER of
 * border tiles toward that point. This does not change attackLogic's troop
 * loss/speed formula (Config.ts) at all — it only changes which border tile
 * is dequeued next in AttackExecution.addNeighbors().
 *
 * The plains map is uniform Plains terrain everywhere, so attackLogic's
 * per-tile cost is identical no matter which tile is conquered. That makes
 * it a clean way to isolate the ordering effect from the combat math: two
 * otherwise-identical attacks that differ only in directionTile should
 * conquer a similar NUMBER of tiles (and lose similar troops) while ending
 * up in visibly different places.
 */
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { TileRef } from "../src/core/game/GameMap";
import { AIM_MAX_VIA } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function conquerRect(game: Game, player: Player, r: Rect): void {
  const map = game.map();
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const t = map.ref(x, y);
      if (map.isLand(t) && !map.isImpassable(t)) {
        player.conquer(t);
      }
    }
  }
}

// plains: 100x100, all Plains terrain. Attacker holds the left half,
// defender the right half, so the whole shared border is the single
// vertical line x=50, y=0..99 — a straight front to push up or down.
const LEFT: Rect = { x: 0, y: 0, w: 50, h: 100 };
const RIGHT: Rect = { x: 50, y: 0, w: 50, h: 100 };

async function setupBorderFight(): Promise<{
  game: Game;
  attacker: Player;
  defender: Player;
}> {
  const attackerInfo = new PlayerInfo(
    "attacker",
    PlayerType.Human,
    null,
    "attacker",
  );
  const defenderInfo = new PlayerInfo(
    "defender",
    PlayerType.Human,
    null,
    "defender",
  );
  const game = await setup(
    "plains",
    {},
    [attackerInfo, defenderInfo],
    undefined,
    UseRealAttackLogic,
  );
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  conquerRect(game, defender, RIGHT);
  conquerRect(game, attacker, LEFT);
  attacker.setTroops(50_000);
  defender.setTroops(50_000);
  return { game, attacker, defender };
}

/** Average y of the tiles `player` now owns inside the old RIGHT rect. */
function avgConqueredY(game: Game, player: Player): number | null {
  const map = game.map();
  let sumY = 0;
  let count = 0;
  for (const tile of player.tiles()) {
    if (map.x(tile) >= RIGHT.x) {
      sumY += map.y(tile);
      count++;
    }
  }
  return count === 0 ? null : sumY / count;
}

describe("Directed attacks", () => {
  it("pulls conquest toward the chosen point without changing troop losses", () => {
    const ticks = 40;
    const attackTroops = 20_000;

    return (async () => {
      const top = await setupBorderFight();
      const topDirection: TileRef = top.game.ref(50, 0);
      top.game.addExecution(
        new AttackExecution(
          attackTroops,
          top.attacker,
          "defender",
          null,
          true,
          topDirection,
        ),
      );

      const bottom = await setupBorderFight();
      const bottomDirection: TileRef = bottom.game.ref(50, 99);
      bottom.game.addExecution(
        new AttackExecution(
          attackTroops,
          bottom.attacker,
          "defender",
          null,
          true,
          bottomDirection,
        ),
      );

      const attackerTroopsBefore = top.attacker.troops(); // same for both, pre-attack
      const defenderTroopsBefore = top.defender.troops();

      for (let i = 0; i < ticks; i++) {
        top.game.executeNextTick();
        bottom.game.executeNextTick();
      }

      const topAvgY = avgConqueredY(top.game, top.attacker);
      const bottomAvgY = avgConqueredY(bottom.game, bottom.attacker);
      expect(topAvgY).not.toBeNull();
      expect(bottomAvgY).not.toBeNull();
      // Aiming at y=0 pulls conquest well toward the top; aiming at y=99
      // pulls it well toward the bottom (map midpoint is y=50).
      expect(topAvgY!).toBeLessThan(40);
      expect(bottomAvgY!).toBeGreaterThan(60);

      const topTilesConquered = top.attacker.numTilesOwned() - LEFT.w * LEFT.h;
      const bottomTilesConquered =
        bottom.attacker.numTilesOwned() - LEFT.w * LEFT.h;
      const topAttackerLoss =
        attackerTroopsBefore -
        top.attacker.troops() -
        top.attacker.outgoingAttacks().reduce((sum, a) => sum + a.troops(), 0);
      const bottomAttackerLoss =
        attackerTroopsBefore -
        bottom.attacker.troops() -
        bottom.attacker
          .outgoingAttacks()
          .reduce((sum, a) => sum + a.troops(), 0);
      const topDefenderLoss = defenderTroopsBefore - top.defender.troops();
      const bottomDefenderLoss =
        defenderTroopsBefore - bottom.defender.troops();

      // Uniform Plains terrain means attackLogic's per-tile cost is exactly
      // the same everywhere on this map: redirecting the push must not
      // change how many tiles get conquered or how many troops either side
      // loses — only where the conquest happens.
      expect(topTilesConquered).toBeGreaterThan(0);
      expect(topTilesConquered).toBe(bottomTilesConquered);
      expect(topAttackerLoss).toBe(bottomAttackerLoss);
      expect(topDefenderLoss).toBe(bottomDefenderLoss);
    })();
  });

  describe("aim corridor (drawn arrow)", () => {
    // Must match AIM_CORRIDOR_HALF_WIDTH / AIM_CORRIDOR_BACK in
    // AttackExecution.ts.
    const HALF_WIDTH = 8;
    const BACK = 8;
    // Arrow from inside the attacker's half, up and to the right into the
    // defender's half.
    const FROM = { x: 40, y: 60 };
    const TIP = { x: 70, y: 30 };

    /** Same integer test as AttackExecution.aimSegmentOf. */
    function inCorridor(x: number, y: number): boolean {
      const dx = TIP.x - FROM.x;
      const dy = TIP.y - FROM.y;
      const len2 = dx * dx + dy * dy;
      const rx = x - FROM.x;
      const ry = y - FROM.y;
      const along = rx * dx + ry * dy;
      if (along < 0 && along * along > BACK * BACK * len2) return false;
      const cross = rx * dy - ry * dx;
      return cross * cross <= HALF_WIDTH * HALF_WIDTH * len2;
    }

    function conqueredInRight(game: Game, player: Player) {
      const map = game.map();
      return [...player.tiles()]
        .filter((t) => map.x(t) >= RIGHT.x)
        .map((t) => ({ x: map.x(t), y: map.y(t) }));
    }

    function aimed(game: Game, attacker: Player, troops: number) {
      return new AttackExecution(
        troops,
        attacker,
        "defender",
        null,
        true,
        game.ref(TIP.x, TIP.y),
        game.ref(FROM.x, FROM.y),
      );
    }

    it("only takes the defender's tiles inside the band along the arrow", async () => {
      const { game, attacker } = await setupBorderFight();
      game.addExecution(aimed(game, attacker, 20_000));
      for (let i = 0; i < 40; i++) game.executeNextTick();

      const taken = conqueredInRight(game, attacker);
      expect(taken.length).toBeGreaterThan(50);
      for (const { x, y } of taken) {
        expect(inCorridor(x, y), `(${x},${y}) is outside the corridor`).toBe(
          true,
        );
      }

      // Same troops, no arrow: spread thin over the whole border, it gets
      // nowhere near as deep as the corridor push.
      const plain = await setupBorderFight();
      plain.game.addExecution(
        new AttackExecution(20_000, plain.attacker, "defender"),
      );
      for (let i = 0; i < 40; i++) plain.game.executeNextTick();
      const plainDepth = Math.max(
        ...conqueredInRight(plain.game, plain.attacker).map((t) => t.x),
      );
      const aimedDepth = Math.max(...taken.map((t) => t.x));
      expect(aimedDepth).toBeGreaterThan(plainDepth + 3);
    });

    it("stacks each extra wave into the same corridor attack", async () => {
      const { game, attacker } = await setupBorderFight();
      game.addExecution(aimed(game, attacker, 10_000));
      for (let i = 0; i < 5; i++) game.executeNextTick();
      const afterFirst = attacker.outgoingAttacks();
      expect(afterFirst.length).toBe(1);
      const firstLeft = afterFirst[0].troops();

      game.addExecution(aimed(game, attacker, 10_000));
      game.executeNextTick();
      const merged = attacker.outgoingAttacks();
      // One attack, carrying what was left of wave 1 plus all of wave 2
      // (minus at most one tick of fighting).
      expect(merged.length).toBe(1);
      expect(merged[0].troops()).toBeGreaterThan(firstLeft + 10_000 - 2_000);
      expect(merged[0].troops()).toBeLessThanOrEqual(firstLeft + 10_000);

      for (let i = 0; i < 30; i++) game.executeNextTick();
      for (const { x, y } of conqueredInRight(game, attacker)) {
        expect(inCorridor(x, y)).toBe(true);
      }
    });

    /**
     * Same integer test as AttackExecution.aimSegmentOf for a bent path:
     * union of bands around each segment; the first reaches BACK behind its
     * start, inner joints overlap by HALF_WIDTH, only the last runs on.
     */
    function inPath(x: number, y: number, pts: { x: number; y: number }[]) {
      const hw2 = HALF_WIDTH * HALF_WIDTH;
      for (let i = 0; i + 1 < pts.length; i++) {
        const dx = pts[i + 1].x - pts[i].x;
        const dy = pts[i + 1].y - pts[i].y;
        const len2 = dx * dx + dy * dy;
        const rx = x - pts[i].x;
        const ry = y - pts[i].y;
        const along = rx * dx + ry * dy;
        if (along < 0) {
          const back2 = i === 0 ? BACK * BACK : hw2;
          if (along * along > back2 * len2) continue;
        } else if (along > len2 && i + 2 < pts.length) {
          const past = along - len2;
          if (past * past > hw2 * len2) continue;
        }
        const cross = rx * dy - ry * dx;
        if (cross * cross <= hw2 * len2) return true;
      }
      return false;
    }

    it("follows a bent path, turning at each bend", async () => {
      const { game, attacker } = await setupBorderFight();
      attacker.setTroops(2_000_000);
      // Z-shaped arrow: right, then down, then right again.
      const path = [
        { x: 40, y: 20 },
        { x: 65, y: 20 },
        { x: 65, y: 75 },
        { x: 90, y: 75 },
      ];
      game.addExecution(
        new AttackExecution(
          1_000_000,
          attacker,
          "defender",
          null,
          true,
          game.ref(path[3].x, path[3].y),
          game.ref(path[0].x, path[0].y),
          [game.ref(path[1].x, path[1].y), game.ref(path[2].x, path[2].y)],
        ),
      );
      const reachedLastLeg = () =>
        conqueredInRight(game, attacker).some((t) => t.x >= 80 && t.y >= 70);
      for (let i = 0; i < 600 && !reachedLastLeg(); i++) {
        game.executeNextTick();
      }

      const taken = conqueredInRight(game, attacker);
      expect(reachedLastLeg()).toBe(true);
      for (const { x, y } of taken) {
        expect(inPath(x, y, path), `(${x},${y}) is off the path`).toBe(true);
      }
      // It turned at the first bend instead of carrying straight on.
      expect(taken.some((t) => t.x >= 76 && t.y <= 28)).toBe(false);
    });

    it("follows a long freehand line (a U-turn) point by point", async () => {
      const { game, attacker } = await setupBorderFight();
      attacker.setTroops(2_000_000);
      // Right along y=20, round a half circle through x=95, back left along
      // y=70, then down: the tip ends up close to where the line started,
      // so only following the line (not heading for the tip) gets there.
      const path = [
        { x: 40, y: 20 },
        { x: 55, y: 20 },
      ];
      for (let k = 0; k <= 12; k++) {
        const a = -Math.PI / 2 + (Math.PI * k) / 12;
        path.push({
          x: Math.round(70 + 25 * Math.cos(a)),
          y: Math.round(45 + 25 * Math.sin(a)),
        });
      }
      path.push({ x: 62, y: 70 }, { x: 62, y: 90 });
      const ref = (p: { x: number; y: number }) => game.ref(p.x, p.y);
      game.addExecution(
        new AttackExecution(
          1_000_000,
          attacker,
          "defender",
          null,
          true,
          ref(path[path.length - 1]),
          ref(path[0]),
          path.slice(1, -1).map(ref),
        ),
      );
      const reachedTail = () =>
        conqueredInRight(game, attacker).some((t) => t.y >= 85 && t.x <= 66);
      for (let i = 0; i < 1500 && !reachedTail(); i++) {
        game.executeNextTick();
      }

      const taken = conqueredInRight(game, attacker);
      expect(reachedTail()).toBe(true);
      for (const { x, y } of taken) {
        expect(inPath(x, y, path), `(${x},${y}) is off the path`).toBe(true);
      }
      // It went round the far side of the curve...
      expect(taken.some((t) => t.x >= 92 && t.y >= 40 && t.y <= 50)).toBe(true);
      // ...and never cut through the middle of the U.
      expect(
        taken.some((t) => t.x >= 60 && t.x <= 68 && t.y >= 36 && t.y <= 54),
      ).toBe(false);
    });

    it("uses at most AIM_MAX_VIA points of a path", async () => {
      const { game, attacker } = await setupBorderFight();
      attacker.setTroops(2_000_000);
      // 30 points along y=20, then 10 more heading far down. Only the first
      // 30 count, so the line runs straight on along y=20 to the tip.
      const via: TileRef[] = [];
      for (let x = 41; x <= 70; x++) via.push(game.ref(x, 20));
      for (let y = 30; y <= 75; y += 5) via.push(game.ref(70, y));
      expect(via.length).toBe(AIM_MAX_VIA + 10);
      game.addExecution(
        new AttackExecution(
          1_000_000,
          attacker,
          "defender",
          null,
          true,
          game.ref(95, 20),
          game.ref(40, 20),
          via,
        ),
      );
      for (let i = 0; i < 300; i++) game.executeNextTick();
      const taken = conqueredInRight(game, attacker);
      expect(taken.some((t) => t.x >= 90)).toBe(true);
      expect(taken.some((t) => t.y > 30)).toBe(false);
    });

    it("keeps a straight arrow's corridor unchanged when no bends are given", async () => {
      const straight = await setupBorderFight();
      straight.game.addExecution(
        aimed(straight.game, straight.attacker, 20_000),
      );
      const viaEmpty = await setupBorderFight();
      viaEmpty.game.addExecution(
        new AttackExecution(
          20_000,
          viaEmpty.attacker,
          "defender",
          null,
          true,
          viaEmpty.game.ref(TIP.x, TIP.y),
          viaEmpty.game.ref(FROM.x, FROM.y),
          [],
        ),
      );
      for (let i = 0; i < 40; i++) {
        straight.game.executeNextTick();
        viaEmpty.game.executeNextTick();
      }
      expect(conqueredInRight(viaEmpty.game, viaEmpty.attacker)).toEqual(
        conqueredInRight(straight.game, straight.attacker),
      );
    });

    it("falls back to a normal border-wide attack for a zero-length arrow", async () => {
      const { game, attacker } = await setupBorderFight();
      game.addExecution(
        new AttackExecution(
          20_000,
          attacker,
          "defender",
          null,
          true,
          game.ref(60, 50),
          game.ref(60, 50),
        ),
      );
      for (let i = 0; i < 40; i++) game.executeNextTick();
      const ys = conqueredInRight(game, attacker).map((t) => t.y);
      // Spread along the whole shared border, not a narrow band.
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(60);
    });

    it("ignores aim tiles that are not on the map", async () => {
      const { game, attacker } = await setupBorderFight();
      game.addExecution(
        new AttackExecution(
          20_000,
          attacker,
          "defender",
          null,
          true,
          999_999_999,
          999_999_998,
        ),
      );
      for (let i = 0; i < 20; i++) game.executeNextTick();
      expect(attacker.numTilesOwned()).toBeGreaterThan(LEFT.w * LEFT.h);
    });
  });

  it("behaves exactly as before when no direction is given", async () => {
    // With directionTile omitted, AttackExecution must be unaffected: this
    // guards against the new field changing default behavior for the many
    // existing undirected attacks in the game and test suite.
    const { game, attacker } = await setupBorderFight();
    game.addExecution(new AttackExecution(20_000, attacker, "defender"));
    for (let i = 0; i < 20; i++) {
      game.executeNextTick();
    }
    expect(attacker.numTilesOwned()).toBeGreaterThan(LEFT.w * LEFT.h);
  });
});
