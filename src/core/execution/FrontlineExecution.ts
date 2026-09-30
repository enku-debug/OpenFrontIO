import { z } from "zod";
import { frontlineNodeTiles } from "../game/Frontline";
import { Execution, Game, Player, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { zInt, zPlayerRef, zRef } from "../snapshot/SnapshotType";

/**
 * The "build_frontline" intent: builds a Frontline along a line the player
 * drew on their border, as a chain of UnitType.Frontline nodes (see
 * frontlineNodeTiles). Each node costs unitInfo(Frontline).cost and must be
 * on the player's land near their border (PlayerImpl.frontlineNodeSpawn);
 * nodes that don't fit are skipped, and building stops when gold runs out.
 * Nodes too close to one of the player's existing nodes are skipped too, so
 * redrawing over a line doesn't stack it.
 *
 * All nodes finish together after the construction time. Each node then
 * covers Config.frontlineRange() around it (AttackExecution), so the chain
 * covers a band along the line. A node on a captured tile is destroyed
 * (PlayerExecution), which cuts the line there.
 */
export class FrontlineExecution implements Execution {
  private mg: Game | undefined;
  private active = true;
  private started = false;
  private nodes: Unit[] = [];
  private ticksLeft = 0;

  constructor(
    private player: Player,
    private path: TileRef[],
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (mg.config().isUnitDisabled(UnitType.Frontline)) {
      this.active = false;
    }
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === undefined) return;
    if (!this.started) {
      this.started = true;
      this.build(mg);
      if (this.nodes.length === 0) {
        this.active = false;
        return;
      }
      this.ticksLeft =
        mg.unitInfo(UnitType.Frontline).constructionDuration ?? 0;
    }
    if (this.ticksLeft > 0) {
      this.ticksLeft--;
      return;
    }
    for (const n of this.nodes) {
      if (n.isActive()) n.setUnderConstruction(false);
    }
    this.active = false;
  }

  private build(mg: Game) {
    const player = this.player;
    if (!player.isAlive()) return;
    const config = mg.config();
    const spacing = config.frontlineNodeSpacing();
    const tiles = frontlineNodeTiles(
      mg,
      this.path,
      spacing,
      config.frontlineMaxLength(),
    );
    const duration = mg.unitInfo(UnitType.Frontline).constructionDuration;
    for (const tile of tiles) {
      if (player.frontlineNodeSpawn(tile) === false) continue;
      if (
        mg.hasUnitNearby(
          tile,
          spacing - 1,
          UnitType.Frontline,
          player.id(),
          true,
        )
      ) {
        continue;
      }
      const cost = mg.unitInfo(UnitType.Frontline).cost(mg, player);
      if (player.gold() < cost) break;
      const node = player.buildUnit(UnitType.Frontline, tile, {});
      if ((duration ?? 0) > 0) node.setUnderConstruction(true);
      this.nodes.push(node);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return FrontlineExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      started: this.started,
      player: w.player(this.player),
      path: this.path,
      nodes: this.nodes.filter((n) => n.isActive()).map((n) => w.unit(n)),
      ticksLeft: this.ticksLeft,
    });
  }

  restoreSnapshot(s: FrontlineState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.started = s.started;
    this.player = r.player(s.player);
    this.path = s.path;
    this.nodes = s.nodes.map((i) => r.unit(i));
    this.ticksLeft = s.ticksLeft;
  }
}

const FrontlineStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  started: z.boolean(),
  player: zPlayerRef(),
  path: z.array(zInt()),
  nodes: z.array(zRef()),
  ticksLeft: zInt(),
});
type FrontlineState = z.infer<typeof FrontlineStateSchema>;

export const FrontlineExecutionSnapshot = execSnapshotType({
  name: "Frontline",
  version: 1,
  schema: FrontlineStateSchema,
  cls: () => FrontlineExecution,
});
