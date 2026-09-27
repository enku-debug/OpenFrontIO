import { z } from "zod";
import { renderTroops } from "../../client/Utils";
import { AttackLogicInput } from "../configuration/Config";
import {
  Attack,
  Difficulty,
  Execution,
  Game,
  MessageType,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
  TerraNullius,
  UnitType,
} from "../game/Game";
import { GameMap, TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
  zRef,
  zTile,
  zTiles,
} from "../snapshot/SnapshotType";
import { assertNever } from "../Util";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap"; // adjust path if needed

const malusForRetreat = 25;
// Directional-attack tuning: how strongly a player-chosen target point pulls
// the conquest order towards it. This only reorders WHICH border tile is
// conquered next (see addNeighbors below) — it never touches attackLogic's
// troop-loss/speed numbers in Config.ts, so combat math is unchanged.
const DIRECTION_BIAS_WEIGHT = 40;
// Aim corridor (player drew an arrow: aimFromTile -> [aimVia...] ->
// directionTile). The attack then only takes enemy tiles within this many
// tiles either side of the arrow's path — the rest of the shared border
// stays put, so every allotted troop pushes along the arrow. Like the bias
// above this only decides WHICH tiles are eligible; attackLogic's numbers
// are untouched.
const AIM_CORRIDOR_HALF_WIDTH = 8;
// How far behind the arrow's start the band still reaches, so the border
// right where the drag began is included.
const AIM_CORRIDOR_BACK = 8;
// A drawn path may bend at most this many times (so up to 3 segments).
const AIM_MAX_BENDS = 2;
// Squared once for the integer-only corridor test in inAimCorridor().
const AIM_HALF_WIDTH_SQ = AIM_CORRIDOR_HALF_WIDTH * AIM_CORRIDOR_HALF_WIDTH;
const AIM_BACK_SQ = AIM_CORRIDOR_BACK * AIM_CORRIDOR_BACK;
// Per-segment layout of AttackExecution.aimSeg, and its flag bits.
const AIM_SEG_STRIDE = 6; // ax, ay, dx, dy, len2, flags
const AIM_SEG_FIRST = 1; // may reach AIM_CORRIDOR_BACK behind its start
const AIM_SEG_LAST = 2; // keeps going past its end (the arrow's tip)
export class AttackExecution implements Execution {
  private active: boolean = true;
  private toConquer = new FlatBinaryHeap();

  private random = new PseudoRandom(123);

  private target: Player | TerraNullius;

  private mg: Game;
  // Direct GameMap reference to skip the Game delegation hop in hot loops.
  private map: GameMap;

  private attack: Attack | null = null;

  // Cached smallIDs for integer owner comparisons in hot loops.
  private ownerSmallID: number;
  private targetSmallID: number;
  // Reusable neighbor buffers to avoid closures/allocation in hot loops.
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private nbuf2: TileRef[] = [0, 0, 0, 0];

  // width()+height(), cached so the direction bias below scales the same
  // way on any map size. Recomputed in init()/restoreSnapshot(), never
  // itself part of the persisted snapshot.
  private mapDiag = 1;

  // Aim corridor geometry in whole tiles, AIM_SEG_STRIDE numbers per path
  // segment: start (ax, ay), vector (dx, dy), len2 = |vector|^2 and flags.
  // Empty when there is no corridor. Derived from the aim tiles in
  // setupAimCorridor(), never persisted.
  private aimSeg: number[] = [];

  constructor(
    private startTroops: number | null = null,
    private _owner: Player,
    private _targetID: PlayerID | null,
    private sourceTile: TileRef | null = null,
    private removeTroops: boolean = true,
    // Tile the player aimed at (e.g. where they right-clicked) to say which
    // way to push the attack. Null keeps the old undirected behavior.
    private directionTile: TileRef | null = null,
    // Start of an aim arrow the player drew. Together with directionTile (the
    // arrow's tip) it turns the attack into a corridor push along the arrow;
    // null keeps the plain directional pull above.
    private aimFromTile: TileRef | null = null,
    // Where a drawn arrow bends, in order (0 to AIM_MAX_BENDS tiles): the
    // path runs aimFromTile -> aimVia... -> directionTile.
    private aimVia: TileRef[] = [],
  ) {}

  public targetID(): PlayerID | null {
    return this._targetID;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;
    this.map = mg.map();
    this.mapDiag = this.map.width() + this.map.height();
    // Aim tiles come straight from the client; ignore any that aren't on the
    // map rather than steering by garbage coordinates.
    if (
      this.directionTile !== null &&
      !this.map.isValidRef(this.directionTile)
    ) {
      this.directionTile = null;
    }
    if (this.aimFromTile !== null && !this.map.isValidRef(this.aimFromTile)) {
      this.aimFromTile = null;
    }
    this.aimVia = this.aimVia
      .filter((t) => this.map.isValidRef(t))
      .slice(0, AIM_MAX_BENDS);
    this.setupAimCorridor();

    if (this._targetID !== null && !mg.hasPlayer(this._targetID)) {
      console.warn(`target ${this._targetID} not found`);
      this.active = false;
      return;
    }

    this.target =
      this._targetID === this.mg.terraNullius().id()
        ? mg.terraNullius()
        : mg.player(this._targetID);
    this.ownerSmallID = this._owner.smallID();
    this.targetSmallID = this.target.smallID();

    if (this._owner === this.target) {
      console.error(`Player ${this._owner} cannot attack itself`);
      this.active = false;
      return;
    }

    // ALLIANCE CHECK — block attacks on friendly (ally or same team)
    if (this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (this._owner.isFriendly(targetPlayer)) {
        console.warn(
          `${this._owner.displayName()} cannot attack ${targetPlayer.displayName()} because they are friendly (allied or same team)`,
        );
        this.active = false;
        return;
      }
    }

    if (this.target && this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (
        targetPlayer.type() !== PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        // Don't let bots embargo since they can't trade anyway.
        targetPlayer.addEmbargo(this._owner, true);
        this.rejectIncomingAllianceRequests(targetPlayer);
      }
    }

    if (this.target.isPlayer() && !this._owner.canAttackPlayer(this.target)) {
      this.active = false;
      return;
    }

    this.startTroops ??= this.mg
      .config()
      .attackAmount(this._owner, this.target);
    if (this.removeTroops) {
      this.startTroops = Math.min(this._owner.troops(), this.startTroops);
      // Take the amount that was actually deducted, not the amount asked for.
      // removeTroops() floors, so a fractional request leaves the attack
      // holding troops the owner never paid for — and retreat refunds the
      // combined total, turning the leftover fractions into free troops.
      this.startTroops = this._owner.removeTroops(this.startTroops);
    }
    this.attack = this._owner.createAttack(
      this.target,
      this.startTroops,
      this.sourceTile,
      new Set<TileRef>(),
    );

    if (this.sourceTile !== null) {
      this.addNeighbors(this.sourceTile);
    } else {
      this.refreshToConquer();
    }

    // Record stats
    this.mg.stats().attack(this._owner, this.target, this.startTroops);

    for (const incoming of this._owner.incomingAttacks()) {
      if (incoming.attacker() === this.target) {
        // Target has opposing attack, cancel them out
        if (incoming.troops() > this.attack.troops()) {
          incoming.setTroops(incoming.troops() - this.attack.troops());
          this.attack.delete();
          this.active = false;
          return;
        } else {
          this.attack.setTroops(this.attack.troops() - incoming.troops());
          incoming.delete();
        }
      }
    }
    for (const outgoing of this._owner.outgoingAttacks()) {
      if (
        outgoing !== this.attack &&
        outgoing.target() === this.attack.target() &&
        // Boat attacks (sourceTile is not null) are not combined with other attacks
        this.attack.sourceTile() === null
      ) {
        this.attack.setTroops(this.attack.troops() + outgoing.troops());
        outgoing.delete();
      }
    }

    // Only now is it known how large the attack the defender actually faces
    // is: a big assault is built by clicking repeatedly, and each click's
    // execution absorbs the earlier ones above. Recorded before the loops it
    // would measure one click, and would count an attack that cancelled out
    // and never landed.
    this.mg.stats().attackMaxIncoming(this.target, this.attack.troops());

    if (this.target.isPlayer()) {
      const difficulty = this.mg.config().gameConfig().difficulty;
      let relationChange: number;
      switch (difficulty) {
        case Difficulty.Easy:
          relationChange = -60;
          break;
        case Difficulty.Medium:
          relationChange = -70;
          break;
        case Difficulty.Hard:
          relationChange = -80;
          break;
        case Difficulty.Impossible:
          relationChange = -100;
          break;
        default:
          assertNever(difficulty);
      }
      this.target.updateRelation(this._owner, relationChange);
    }
  }

  private setupAimCorridor() {
    this.aimSeg = [];
    if (this.aimFromTile === null || this.directionTile === null) return;
    // Path points in order, skipping repeats (a zero-length leg has no
    // direction).
    const pts: number[] = [];
    for (const t of [this.aimFromTile, ...this.aimVia, this.directionTile]) {
      const x = this.map.x(t);
      const y = this.map.y(t);
      const n = pts.length;
      if (n > 0 && pts[n - 2] === x && pts[n - 1] === y) continue;
      pts.push(x, y);
    }
    // All points equal (a zero-length arrow) leaves no segment, so no
    // corridor: the attack falls back to the plain pull.
    const segments = pts.length / 2 - 1;
    for (let i = 0; i < segments; i++) {
      const ax = pts[2 * i];
      const ay = pts[2 * i + 1];
      const dx = pts[2 * i + 2] - ax;
      const dy = pts[2 * i + 3] - ay;
      const flags =
        (i === 0 ? AIM_SEG_FIRST : 0) | (i === segments - 1 ? AIM_SEG_LAST : 0);
      this.aimSeg.push(ax, ay, dx, dy, dx * dx + dy * dy, flags);
    }
  }

  /**
   * Whether `tile` lies in the aim corridor: within AIM_CORRIDOR_HALF_WIDTH
   * of any segment of the arrow's path. The first segment also reaches
   * AIM_CORRIDOR_BACK behind the start; bends overlap by the half-width so
   * the corner is covered; only the last segment keeps going past its end.
   * Integer arithmetic only (squared distances scaled by |segment|^2), so
   * every client computes the identical answer.
   */
  private inAimCorridor(tile: TileRef): boolean {
    const tx = this.map.x(tile);
    const ty = this.map.y(tile);
    const seg = this.aimSeg;
    for (let i = 0; i < seg.length; i += AIM_SEG_STRIDE) {
      const dx = seg[i + 2];
      const dy = seg[i + 3];
      const len2 = seg[i + 4];
      const flags = seg[i + 5];
      const rx = tx - seg[i];
      const ry = ty - seg[i + 1];
      const along = rx * dx + ry * dy; // = dist·|seg|·cos
      if (along < 0) {
        const backSq = flags & AIM_SEG_FIRST ? AIM_BACK_SQ : AIM_HALF_WIDTH_SQ;
        if (along * along > backSq * len2) continue;
      } else if (along > len2 && !(flags & AIM_SEG_LAST)) {
        const past = along - len2; // = dist past the segment's end·|seg|
        if (past * past > AIM_HALF_WIDTH_SQ * len2) continue;
      }
      const cross = rx * dy - ry * dx; // = dist·|seg|·sin
      if (cross * cross <= AIM_HALF_WIDTH_SQ * len2) return true;
    }
    return false;
  }

  private refreshToConquer() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.toConquer.clear();
    this.attack.clearBorder();
    // forEach over the dense storage — the values() generator showed up in long-game profiles
    this._owner.borderTiles().forEach((tile) => this.addNeighbors(tile));
  }

  private retreat(malusPercent = 0) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const deaths = this.attack.troops() * (malusPercent / 100);
    if (deaths) {
      this.mg.displayMessage(
        "events_display.attack_cancelled_retreat",
        MessageType.ATTACK_CANCELLED,
        this._owner.id(),
        undefined,
        { troops: renderTroops(deaths) },
      );
    }
    if (this.removeTroops === false && this.sourceTile === null) {
      // startTroops are always added to attack troops at init but not always removed from owner troops
      // subtract startTroops from attack troops so we don't give back startTroops to owner that were never removed
      // boat attacks (sourceTile !== null) are the exception: troops were removed at departure and must be returned after attack still
      this.attack.setTroops(this.attack.troops() - (this.startTroops ?? 0));
    }

    const survivors = this.attack.troops() - deaths;
    this._owner.addTroops(survivors);
    this.attack.delete();
    this.active = false;

    // Not all retreats are canceled attacks
    if (this.attack.retreated()) {
      // Record stats
      this.mg.stats().attackCancel(this._owner, this.target, survivors);
    }
  }

  tick(ticks: number) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }
    let troopCount = this.attack.troops(); // cache troop count
    const targetIsPlayer = this.target.isPlayer(); // cache target type
    const targetPlayer = targetIsPlayer ? (this.target as Player) : null; // cache target player

    if (this.attack.retreated()) {
      if (targetIsPlayer) {
        this.retreat(malusForRetreat);
      } else {
        this.retreat();
      }
      this.active = false;
      return;
    }

    if (this.attack.retreating()) {
      return;
    }

    if (!this.attack.isActive()) {
      this.active = false;
      return;
    }

    if (targetPlayer && this._owner.isFriendly(targetPlayer)) {
      // In this case a new alliance was created AFTER the attack started.
      this.retreat();
      return;
    }

    const borderSize = this.attack.borderSize() + this.random.nextInt(0, 5);
    // Each tile consumes a fraction of the tick; conquer until it is spent.
    let tickBudget = 1;

    while (tickBudget > 0) {
      if (troopCount < 1) {
        this.attack.delete();
        this.active = false;
        return;
      }

      if (this.toConquer.size() === 0) {
        this.refreshToConquer();
        this.retreat();
        return;
      }

      const tileToConquer = this.toConquer.dequeue();
      this.attack.removeBorderTile(tileToConquer);

      let onBorder = false;
      const numNeighbors = this.map.neighbors4(tileToConquer, this.nbuf);
      for (let i = 0; i < numNeighbors; i++) {
        if (this.map.ownerID(this.nbuf[i]) === this.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (this.map.ownerID(tileToConquer) !== this.targetSmallID || !onBorder) {
        continue;
      }
      if (
        !this.map.isLand(tileToConquer) ||
        this.map.isImpassable(tileToConquer)
      ) {
        continue;
      }
      this.addNeighbors(tileToConquer);
      const { attackerTroopLoss, defenderTroopLoss, tickFraction } = this.mg
        .config()
        .attackLogic(
          this.attackLogicInput(troopCount, tileToConquer, borderSize),
        );
      tickBudget -= tickFraction;
      troopCount -= attackerTroopLoss;
      this.attack.setTroops(troopCount);
      if (targetPlayer) {
        targetPlayer.removeTroops(defenderTroopLoss);
      }
      this._owner.conquer(tileToConquer);
      this.handleDeadDefender();
    }
  }

  private attackLogicInput(
    attackTroops: number,
    tile: TileRef,
    borderSize: number,
  ): AttackLogicInput {
    const defender = this.target.isPlayer() ? this.target : null;
    // Same test as scanning nearbyUnits() for a post owned by the defender
    // (active, not under construction, within range), without building a
    // result array per conquered tile — this runs for every tile of every
    // attack on the map.
    const defenderHasDefensePost =
      defender !== null &&
      this.mg.hasUnitNearby(
        tile,
        this.mg.config().defensePostRange(),
        UnitType.DefensePost,
        defender.id(),
      );
    return {
      terrain: this.map.terrainType(tile),
      attackTroops,
      attacker: {
        type: this._owner.type(),
        numTiles: this._owner.numTilesOwned(),
      },
      defender:
        defender === null
          ? null
          : {
              type: defender.type(),
              numTiles: defender.numTilesOwned(),
              troops: defender.troops(),
              isTraitor: defender.isTraitor(),
              isDisconnectedTeammate:
                defender.isDisconnected() && this._owner.isOnSameTeam(defender),
            },
      defenderHasDefensePost,
      falloutRatio: this.mg.hasFallout(tile)
        ? this.mg.numTilesWithFallout() / this.mg.numLandTiles()
        : null,
      borderSize,
    };
  }

  private rejectIncomingAllianceRequests(target: Player) {
    const request = this._owner
      .incomingAllianceRequests()
      .find((ar) => ar.requestor() === target);
    if (request !== undefined) {
      request.reject();
    }
  }

  private addNeighbors(tile: TileRef) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const tickNow = this.mg.ticks(); // cache tick

    const numNeighbors = this.map.neighbors4(tile, this.nbuf);
    for (let i = 0; i < numNeighbors; i++) {
      const neighbor = this.nbuf[i];
      if (
        this.map.isWater(neighbor) ||
        this.map.isImpassable(neighbor) ||
        this.map.ownerID(neighbor) !== this.targetSmallID
      ) {
        continue;
      }
      // Aimed arrow: the rest of the shared border is left alone.
      if (this.aimSeg.length !== 0 && !this.inAimCorridor(neighbor)) {
        continue;
      }
      this.attack.addBorderTile(neighbor);
      let numOwnedByMe = 0;
      const numInner = this.map.neighbors4(neighbor, this.nbuf2);
      for (let j = 0; j < numInner; j++) {
        if (this.map.ownerID(this.nbuf2[j]) === this.ownerSmallID) {
          numOwnedByMe++;
        }
      }

      let mag: number;
      switch (this.map.terrainType(neighbor)) {
        case TerrainType.Plains:
          mag = 1;
          break;
        case TerrainType.Highland:
          mag = 1.5;
          break;
        case TerrainType.Mountain:
          mag = 2;
          break;
        default:
          mag = 0;
          break;
      }

      // Unchanged from before: random spread + terrain + how enclosed the
      // tile already is, scheduled against the current tick.
      let priority =
        (this.random.nextInt(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) +
        tickNow;

      // Directional pull: tiles nearer the player's chosen point dequeue
      // sooner. Distance is normalized by map size so the pull feels the
      // same on small and large maps; with no direction set this is 0 and
      // conquest order is exactly as before.
      if (this.directionTile !== null) {
        const dist = this.map.manhattanDist(neighbor, this.directionTile);
        priority += (dist / this.mapDiag) * DIRECTION_BIAS_WEIGHT;
      }

      this.toConquer.enqueue(neighbor, priority);
    }
  }

  private handleDeadDefender() {
    if (!(this.target.isPlayer() && this.target.numTilesOwned() < 100)) return;
    const target: Player = this.target;

    this.mg.conquerPlayer(this._owner, target);

    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let progressed = false;
      for (const tile of target.tiles()) {
        let borders = false;
        this.mg.forEachNeighbor(tile, (t) => {
          if (!borders && this.mg.owner(t) === this._owner) {
            borders = true;
          }
        });
        if (borders) {
          this._owner.conquer(tile);
          progressed = true;
        } else {
          let captured = false;
          this.mg.forEachNeighbor(tile, (neighbor) => {
            if (captured) return;
            const no = this.mg.owner(neighbor);
            if (no.isPlayer() && no !== target && !no.isFriendly(target)) {
              this.mg.player(no.id()).conquer(tile);
              captured = true;
            }
          });
          if (captured) progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  owner(): Player {
    return this._owner;
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AttackExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      toConquer: this.toConquer.getState(),
      random: w.random(this.random),
      target: this.target === undefined ? null : w.owner(this.target),
      attack: this.attack === null ? null : w.attack(this.attack),
      startTroops: this.startTroops,
      owner: w.player(this._owner),
      targetID: this._targetID,
      sourceTile: this.sourceTile,
      removeTroops: this.removeTroops,
      directionTile: this.directionTile,
      aimFromTile: this.aimFromTile,
      aimVia: [...this.aimVia],
    });
  }

  restoreSnapshot(s: AttackExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    this.toConquer = FlatBinaryHeap.fromState(s.toConquer);
    this.random = r.random(s.random);
    if (s.initialized) {
      this.mg = r.game;
      this.map = r.game.map();
      this.mapDiag = this.map.width() + this.map.height();
    }
    if (s.target !== null) {
      this.target = r.owner(s.target);
      // Set together with target in init(); small ids are the stored refs.
      this.ownerSmallID = s.owner;
      this.targetSmallID = s.target;
    }
    this.attack = s.attack === null ? null : r.attack(s.attack);
    // Scratch buffers, overwritten before every read.
    this.nbuf = [0, 0, 0, 0];
    this.nbuf2 = [0, 0, 0, 0];
    this.startTroops = s.startTroops;
    this._owner = r.player(s.owner);
    this._targetID = s.targetID;
    this.sourceTile = s.sourceTile;
    this.removeTroops = s.removeTroops;
    this.directionTile = s.directionTile;
    this.aimFromTile = s.aimFromTile;
    this.aimVia = [...s.aimVia];
    // Derived, non-persisted fields: a restored object skips the field
    // initializers, so set them here exactly as a live one would have them.
    if (s.initialized) {
      this.setupAimCorridor();
    } else {
      this.mapDiag = 1;
      this.aimSeg = [];
    }
  }
}

const AttackExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  // Exact heap layout: ties between equal priorities dequeue by position.
  toConquer: z.object({
    pri: z.custom<Float32Array>(
      (v) => v instanceof Float32Array,
      "expected float32s",
    ),
    tiles: zTiles(),
    capacity: zInt(),
  }),
  random: zRandom(),
  /** Null until init() resolves the target. */
  target: zPlayerRef().nullable(),
  attack: zRef().nullable(),
  startTroops: zNum().nullable(),
  owner: zPlayerRef(),
  targetID: z.string().nullable(),
  sourceTile: zTile().nullable(),
  removeTroops: z.boolean(),
  directionTile: zTile().nullable(),
  aimFromTile: zTile().nullable(),
  aimVia: z.array(zTile()),
});
type AttackExecutionState = z.infer<typeof AttackExecutionStateSchema>;

export const AttackExecutionSnapshot = execSnapshotType({
  name: "Attack",
  // Bumped: v2 added directionTile, v3 aimFromTile, v4 aimVia.
  version: 4,
  schema: AttackExecutionStateSchema,
  migrations: {
    // v1 snapshots predate directional attacks: they were always undirected.
    1: (data) => ({ ...data, directionTile: null }),
    // v2 snapshots predate aim corridors.
    2: (data) => ({ ...data, aimFromTile: null }),
    // v3 snapshots predate bent aim paths: every arrow was straight.
    3: (data) => ({ ...data, aimVia: [] }),
  },
  cls: () => AttackExecution,
});
