/**
 * Frontline: a defense line drawn along your border. Built as a chain of
 * UnitType.Frontline nodes (FrontlineExecution), each covering
 * Config.frontlineRange() around it. Stronger than a Defense Post, a bit
 * stronger again where a Defense Post also covers, and it takes away the
 * tanks' lower losses.
 */
import { AttackLogicInput } from "../src/core/configuration/Config";
import { FrontlineExecution } from "../src/core/execution/FrontlineExecution";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { frontlineNodeTiles } from "../src/core/game/Frontline";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "../src/core/game/Game";
import { IntentSchema } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  w: number,
  h: number,
) {
  const map = game.map();
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const t = map.ref(x, y);
      if (map.isLand(t)) p.conquer(t);
    }
  }
}

// plains: 100x100 uniform Plains. Attacker holds x < 50, defender x >= 50.
async function setupFront() {
  const game = await setup(
    "plains",
    { instantBuild: true },
    [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ],
    undefined,
    UseRealAttackLogic,
  );
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  conquerRect(game, defender, 50, 0, 50, 100);
  conquerRect(game, attacker, 0, 0, 50, 100);
  defender.addGold(1_000_000n);
  return { game, attacker, defender };
}

function build(
  game: Game,
  p: Player,
  from: [number, number],
  to: [number, number],
) {
  const map = game.map();
  game.addExecution(
    new FrontlineExecution(p, [map.ref(...from), map.ref(...to)]),
  );
  for (let i = 0; i < 3; i++) game.executeNextTick();
}

describe("Frontline", () => {
  it("puts a node every few tiles along the line, up to the max length", async () => {
    const { game } = await setupFront();
    const map = game.map();
    const c = game.config();
    const tiles = frontlineNodeTiles(
      game,
      [map.ref(51, 10), map.ref(51, 90)],
      c.frontlineNodeSpacing(),
      c.frontlineMaxLength(),
    );
    expect(tiles.map((t) => map.y(t))).toEqual([
      10, 15, 20, 25, 30, 35, 40, 45, 50,
    ]);
    expect(tiles.every((t) => map.x(t) === 51)).toBe(true);
  });

  it("builds nodes on the border for gold, and not deep inland", async () => {
    const { game, defender } = await setupFront();
    const gold = defender.gold();
    build(game, defender, [51, 10], [51, 30]);
    const nodes = defender.units(UnitType.Frontline);
    expect(nodes.length).toBe(5);
    expect(gold - defender.gold()).toBe(5n * 25_000n);

    build(game, defender, [80, 10], [80, 30]);
    expect(defender.units(UnitType.Frontline).length).toBe(5);
    // Redrawing over the same line doesn't stack it.
    build(game, defender, [51, 10], [51, 30]);
    expect(defender.units(UnitType.Frontline).length).toBe(5);
  });

  it("covers a band along the line", async () => {
    const { game, defender } = await setupFront();
    build(game, defender, [51, 10], [51, 50]);
    const map = game.map();
    const covered = (x: number, y: number) =>
      game.hasUnitNearby(
        map.ref(x, y),
        game.config().frontlineRange(),
        UnitType.Frontline,
        defender.id(),
      );
    expect(covered(60, 30)).toBe(true);
    expect(covered(64, 12)).toBe(true);
    expect(covered(51, 80)).toBe(false);
    expect(covered(75, 30)).toBe(false);
  });

  it("loses a node when its tile is captured", async () => {
    const { game, attacker, defender } = await setupFront();
    build(game, defender, [51, 10], [51, 30]);
    attacker.conquer(game.map().ref(51, 20));
    const exec = new PlayerExecution(defender);
    exec.init(game, game.ticks());
    exec.tick(game.ticks());
    expect(defender.units(UnitType.Frontline).length).toBe(4);
  });

  describe("combat numbers (Config.attackLogic)", () => {
    function input(
      armored: boolean,
      post: boolean,
      frontline: boolean,
    ): AttackLogicInput {
      return {
        terrain: TerrainType.Plains,
        attackTroops: 20_000,
        attacker: { type: PlayerType.Human, numTiles: 5_000 },
        defender: {
          type: PlayerType.Human,
          numTiles: 5_000,
          troops: 30_000,
          isTraitor: false,
          isDisconnectedTeammate: false,
        },
        defenderHasDefensePost: post,
        defenderHasFrontline: frontline,
        falloutRatio: null,
        borderSize: 40,
        armored,
      };
    }

    it("is stronger than a Defense Post, stronger still with one", async () => {
      const { game } = await setupFront();
      const c = game.config();
      const post = c.attackLogic(input(false, true, false));
      const front = c.attackLogic(input(false, false, true));
      const both = c.attackLogic(input(false, true, true));
      expect(front.attackerTroopLoss).toBeGreaterThan(post.attackerTroopLoss);
      expect(front.tickFraction).toBeGreaterThan(post.tickFraction);
      expect(both.attackerTroopLoss).toBeCloseTo(
        front.attackerTroopLoss * c.frontlineDefensePostBuff(),
        6,
      );
      expect(both.tickFraction).toBeCloseTo(front.tickFraction * c.frontlineDefensePostBuff(), 6);
    });

    it("takes the tanks' lower losses away, keeps their slowdown", async () => {
      const { game } = await setupFront();
      const c = game.config();
      const troops = c.attackLogic(input(false, false, true));
      const tanks = c.attackLogic(input(true, false, true));
      expect(tanks.attackerTroopLoss).toBeCloseTo(troops.attackerTroopLoss, 6);
      expect(tanks.tickFraction).toBeCloseTo(
        troops.tickFraction * c.tankSlowdown(),
        6,
      );
    });
  });

  it("accepts a build_frontline intent", () => {
    expect(
      IntentSchema.safeParse({ type: "build_frontline", path: [1, 2, 3] })
        .success,
    ).toBe(true);
    expect(
      IntentSchema.safeParse({ type: "build_frontline", path: [] }).success,
    ).toBe(false);
  });
});
