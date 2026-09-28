import { UIState } from "./UIState";
import { translateText } from "./Utils";
import { PlayerView } from "./view/PlayerView";

/** What an attack order sends: an amount of troops, or of tanks. */
export interface AttackForce {
  amount: number;
  armored: boolean;
}

/**
 * The force an attack order sends right now: the attack ratio of your
 * troops, or, in tank mode (UIState.tankMode), of your reserve tanks (whole
 * tanks, at least one). Null in tank mode when you have no tanks.
 */
export function attackForce(
  player: PlayerView,
  uiState: UIState,
): AttackForce | null {
  if (!uiState.tankMode) {
    return { amount: player.troops() * uiState.attackRatio, armored: false };
  }
  const tanks = player.tanks();
  if (tanks < 1) return null;
  return {
    amount: Math.max(1, Math.floor(tanks * uiState.attackRatio)),
    armored: true,
  };
}

/** "12 tanks": how a count of tanks is shown on labels. */
export function renderTanks(tanks: number): string {
  return translateText("control_panel.tanks_count", {
    count: Math.ceil(tanks),
  });
}
