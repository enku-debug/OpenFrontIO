import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { zInt, zPlayerRef } from "../snapshot/SnapshotType";

/**
 * Tanks a player has in total: in reserve plus out on tank attacks (a
 * partly-destroyed tank still counts until it is gone). This is what the
 * Tank Factory cap (Config.maxTanks) limits.
 */
export function tanksOwned(player: Player): number {
  let n = player.tanks();
  for (const a of player.outgoingAttacks()) {
    if (a.armored()) n += Math.ceil(a.troops());
  }
  return n;
}

/**
 * Buy up to `count` tanks for gold: as many as the player can afford at
 * Config.tankCost each and has room for under their Tank Factory cap.
 * Returns how many were bought.
 */
export function buyTanks(mg: Game, player: Player, count: number): number {
  const config = mg.config();
  const room = Math.max(0, config.maxTanks(player) - tanksOwned(player));
  let n = Math.min(Math.floor(count), room);
  const price = config.tankCost(player);
  if (price > 0n) {
    const affordable = player.gold() / price;
    if (BigInt(n) > affordable) n = Number(affordable);
  }
  if (n <= 0) return 0;
  player.removeGold(price * BigInt(n));
  player.addTanks(n);
  return n;
}

/** The "buy_tanks" intent: one purchase, then done. */
export class BuyTanksExecution implements Execution {
  private mg: Game | undefined;
  private active = true;

  constructor(
    private player: Player,
    private count: number,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    this.active = false;
    if (this.mg === undefined || !this.player.isAlive()) return;
    buyTanks(this.mg, this.player, this.count);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return BuyTanksExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      count: this.count,
    });
  }

  restoreSnapshot(s: BuyTanksState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.count = s.count;
  }
}

const BuyTanksStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  count: zInt(),
});
type BuyTanksState = z.infer<typeof BuyTanksStateSchema>;

export const BuyTanksExecutionSnapshot = execSnapshotType({
  name: "BuyTanks",
  version: 1,
  schema: BuyTanksStateSchema,
  cls: () => BuyTanksExecution,
});
