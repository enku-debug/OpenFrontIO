/**
 * Tanks: an armored force separate from troops. A Tank Factory raises the
 * tank cap (Config.maxTanks) per finished level, tanks are bought with gold
 * (BuyTanksExecution), and a tank attack (AttackExecution `armored`) spends
 * tanks instead of troops: slower and tougher than troops of the same
 * strength, and 1.5x as effective against Defense Post cover.
 */
import { AttackLogicInput } from "../src/core/configuration/Config";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import {
  BuyTanksExecution,
  tanksOwned,
} from "../src/core/execution/BuyTanksExecution";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { RetreatExecution } from "../src/core/execution/RetreatExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "../src/core/game/Game";
import { AttackIntentSchema, IntentSchema } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

// plains: 100x100 uniform Plains. Attacker holds x < 50, defender x >= 50.
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

async function setupFight(opts: { instantBuild?: boolean } = {}) {
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
    { instantBuild: opts.instantBuild ?? true },
    [attackerInfo, defenderInfo],
    undefined,
    UseRealAttackLogic,
  );
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  conquerRect(game, defender, 50, 0, 50, 100);
  conquerRect(game, attacker, 0, 0, 50, 100);
  attacker.setTroops(50_000);
  defender.setTroops(50_000);
  return { game, attacker, defender };
}

function tilesTaken(game: Game, attacker: Player): number {
  return [...attacker.tiles()].filter((t) => game.map().x(t) >= 50).length;
}

function tankAttack(game: Game, attacker: Player, tanks: number) {
  return new AttackExecution(
    tanks,
    attacker,
    "defender",
    null,
    true,
    null,
    null,
    [],
    true,
  );
}

describe("Tanks", () => {
  describe("Tank Factory and the tank cap", () => {
    it("allows tanksPerFactoryLevel tanks per finished factory level", async () => {
      const { game, attacker } = await setupFight();
      const config = game.config();
      expect(config.maxTanks(attacker)).toBe(0);

      const factory = attacker.buildUnit(
        UnitType.TankFactory,
        game.ref(10, 10),
        {},
      );
      expect(config.maxTanks(attacker)).toBe(config.tanksPerFactoryLevel());
      factory.increaseLevel();
      expect(config.maxTanks(attacker)).toBe(2 * config.tanksPerFactoryLevel());
      attacker.buildUnit(UnitType.TankFactory, game.ref(30, 30), {});
      expect(config.maxTanks(attacker)).toBe(3 * config.tanksPerFactoryLevel());
    });

    it("is built by a build order, and counts only once finished", async () => {
      const { game, attacker } = await setupFight({ instantBuild: false });
      const cost = game.unitInfo(UnitType.TankFactory).cost(game, attacker);
      attacker.addGold(cost);
      game.addExecution(
        new ConstructionExecution(
          attacker,
          UnitType.TankFactory,
          game.ref(20, 20),
        ),
      );
      game.executeNextTick();
      game.executeNextTick();
      expect(attacker.units(UnitType.TankFactory)).toHaveLength(1);
      expect(attacker.gold() < cost).toBe(true);
      expect(game.config().maxTanks(attacker)).toBe(0); // under construction

      const duration =
        game.unitInfo(UnitType.TankFactory).constructionDuration ?? 0;
      for (let i = 0; i <= duration + 2; i++) game.executeNextTick();
      expect(
        attacker.units(UnitType.TankFactory)[0].isUnderConstruction(),
      ).toBe(false);
      expect(game.config().maxTanks(attacker)).toBe(
        game.config().tanksPerFactoryLevel(),
      );
    });

    it("scraps reserve tanks above the cap when a factory is lost", async () => {
      const { game, attacker } = await setupFight();
      game.addExecution(new PlayerExecution(attacker));
      const factory = attacker.buildUnit(
        UnitType.TankFactory,
        game.ref(10, 10),
        {},
      );
      attacker.addTanks(80);
      game.executeNextTick();
      expect(attacker.tanks()).toBe(80);

      factory.delete();
      game.executeNextTick();
      game.executeNextTick();
      expect(attacker.tanks()).toBe(0);
    });
  });

  describe("buying tanks", () => {
    it("buys up to the cap, for tankCost gold each", async () => {
      const { game, attacker } = await setupFight();
      const config = game.config();
      attacker.buildUnit(UnitType.TankFactory, game.ref(10, 10), {});
      attacker.addGold(10_000_000n);
      const gold0 = attacker.gold();

      game.addExecution(new BuyTanksExecution(attacker, 1_000));
      game.executeNextTick();
      game.executeNextTick();
      const cap = config.maxTanks(attacker);
      expect(attacker.tanks()).toBe(cap);
      expect(gold0 - attacker.gold()).toBe(
        BigInt(cap) * config.tankCost(attacker),
      );

      // Full: a second order buys nothing.
      game.addExecution(new BuyTanksExecution(attacker, 10));
      game.executeNextTick();
      game.executeNextTick();
      expect(attacker.tanks()).toBe(cap);
    });

    it("buys only what the gold covers", async () => {
      const { game, attacker } = await setupFight();
      const price = game.config().tankCost(attacker);
      attacker.buildUnit(UnitType.TankFactory, game.ref(10, 10), {});
      attacker.removeGold(attacker.gold());
      attacker.addGold(price * 7n + price / 2n);
      game.addExecution(new BuyTanksExecution(attacker, 50));
      game.executeNextTick();
      game.executeNextTick();
      expect(attacker.tanks()).toBe(7);
      expect(attacker.gold()).toBe(price / 2n);
    });

    it("counts tanks out on attacks against the cap", async () => {
      const { game, attacker } = await setupFight();
      const cap = game.config().tanksPerFactoryLevel();
      attacker.buildUnit(UnitType.TankFactory, game.ref(10, 10), {});
      attacker.addGold(10_000_000n);
      attacker.addTanks(cap);
      game.addExecution(tankAttack(game, attacker, cap / 2));
      game.executeNextTick();
      expect(attacker.tanks()).toBe(cap / 2);
      expect(tanksOwned(attacker)).toBe(cap);

      game.addExecution(new BuyTanksExecution(attacker, cap));
      game.executeNextTick();
      game.executeNextTick();
      // Only tanks lost in the fighting could be replaced.
      expect(tanksOwned(attacker)).toBeLessThanOrEqual(cap);
      const out = Math.ceil(attacker.outgoingAttacks()[0].troops());
      expect(attacker.tanks()).toBeLessThanOrEqual(cap - out);
    });
  });

  describe("tank attacks", () => {
    it("spend tanks, not troops, and take land", async () => {
      const { game, attacker } = await setupFight();
      attacker.addTanks(40);
      const troops0 = attacker.troops();
      game.addExecution(tankAttack(game, attacker, 25));
      game.executeNextTick();
      expect(attacker.tanks()).toBe(15);
      expect(attacker.troops()).toBe(troops0);
      const attacks = attacker.outgoingAttacks();
      expect(attacks).toHaveLength(1);
      expect(attacks[0].armored()).toBe(true);
      expect(attacks[0].troops()).toBeLessThanOrEqual(25);

      for (let i = 0; i < 30; i++) game.executeNextTick();
      expect(tilesTaken(game, attacker)).toBeGreaterThan(0);
    });

    it("does nothing without tanks", async () => {
      const { game, attacker } = await setupFight();
      game.addExecution(tankAttack(game, attacker, 10));
      game.executeNextTick();
      expect(attacker.outgoingAttacks()).toHaveLength(0);
      expect(attacker.troops()).toBe(50_000);
    });

    it("run beside a troop attack on the same target instead of merging", async () => {
      const { game, attacker } = await setupFight();
      attacker.addTanks(20);
      game.addExecution(tankAttack(game, attacker, 20));
      game.addExecution(new AttackExecution(10_000, attacker, "defender"));
      game.executeNextTick();
      const attacks = attacker.outgoingAttacks();
      expect(attacks).toHaveLength(2);
      expect(attacks.filter((a) => a.armored())).toHaveLength(1);
    });

    it("bring surviving tanks home on retreat", async () => {
      const { game, attacker } = await setupFight();
      attacker.addTanks(40);
      game.addExecution(tankAttack(game, attacker, 40));
      game.executeNextTick();
      const attack = attacker.outgoingAttacks()[0];
      game.addExecution(new RetreatExecution(attacker, attack.id()));
      for (let i = 0; i < 40 && attacker.outgoingAttacks().length > 0; i++) {
        game.executeNextTick();
      }
      expect(attacker.outgoingAttacks()).toHaveLength(0);
      // 25% retreat penalty on a cancelled attack, whole tanks only.
      expect(attacker.tanks()).toBeGreaterThanOrEqual(25);
      expect(attacker.tanks()).toBeLessThanOrEqual(30);
      expect(attacker.troops()).toBe(50_000);
    });

    it("advance slower than troops of the same strength but lose less per tile", async () => {
      const power = (await setupFight()).game.config().tankPower();
      const strength = 20 * power;

      const troops = await setupFight();
      troops.game.addExecution(
        new AttackExecution(strength, troops.attacker, "defender"),
      );
      const tanks = await setupFight();
      tanks.attacker.addTanks(20);
      tanks.game.addExecution(tankAttack(tanks.game, tanks.attacker, 20));

      for (let i = 0; i < 12; i++) {
        troops.game.executeNextTick();
        tanks.game.executeNextTick();
      }
      const troopTiles = tilesTaken(troops.game, troops.attacker);
      const tankTiles = tilesTaken(tanks.game, tanks.attacker);
      expect(tankTiles).toBeGreaterThan(0);
      expect(tankTiles).toBeLessThan(troopTiles);

      const left = (p: Player, perUnit: number) =>
        p.outgoingAttacks().reduce((s, a) => s + a.troops() * perUnit, 0);
      const troopLossPerTile =
        (strength - left(troops.attacker, 1)) / troopTiles;
      const tankLossPerTile =
        (strength - left(tanks.attacker, power)) / tankTiles;
      expect(tankLossPerTile).toBeLessThan(troopLossPerTile * 0.85);
    });
  });

  describe("combat numbers (Config.attackLogic)", () => {
    function input(armored: boolean, post: boolean): AttackLogicInput {
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
        falloutRatio: null,
        borderSize: 40,
        armored,
      };
    }

    it("make tanks slower and tougher, and 1.5x as good against Defense Posts", async () => {
      const { game } = await setupFight();
      const c = game.config();
      for (const post of [false, true]) {
        const troops = c.attackLogic(input(false, post));
        const tanks = c.attackLogic(input(true, post));
        const edge = post ? c.tankDefensePostAdvantage() : 1;
        expect(tanks.attackerTroopLoss).toBeCloseTo(
          (troops.attackerTroopLoss * c.tankLossFactor()) / edge,
          6,
        );
        expect(tanks.tickFraction).toBeCloseTo(
          (troops.tickFraction * c.tankSlowdown()) / edge,
          6,
        );
        expect(tanks.defenderTroopLoss).toBe(troops.defenderTroopLoss);
      }
      expect(c.tankDefensePostAdvantage()).toBe(1.5);
    });

    it("leave troop attacks exactly as before", async () => {
      const { game } = await setupFight();
      const c = game.config();
      const plain = { ...input(false, true) };
      delete plain.armored;
      expect(c.attackLogic(plain)).toEqual(c.attackLogic(input(false, true)));
    });
  });

  describe("intents", () => {
    it("accept a buy_tanks order and an armored attack", () => {
      expect(
        IntentSchema.safeParse({ type: "buy_tanks", count: 10 }).success,
      ).toBe(true);
      expect(
        AttackIntentSchema.safeParse({
          type: "attack",
          targetID: null,
          troops: 5,
          armored: true,
        }).success,
      ).toBe(true);
      expect(
        IntentSchema.safeParse({ type: "buy_tanks", count: -1 }).success,
      ).toBe(false);
    });
  });
});
