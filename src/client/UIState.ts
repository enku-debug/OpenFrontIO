import { PlayerBuildableUnitType } from "../core/game/Game";

export interface UIState {
  attackRatio: number;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
  /**
   * When true, a single-pointer drag on the map draws a directional-aim
   * arrow instead of panning the camera; releasing fires an attack aimed at
   * the arrow's tip (see DirectionAimController / InputHandler's
   * DirectionAim* events). Toggled by the aim button in ControlPanel.
   */
  directionalAimMode: boolean;
  /**
   * Tank mode: attack orders (click, G key, radial menu, Aim arrows) send
   * tanks instead of troops — the attack ratio of your reserve tanks (see
   * AttackForce.attackForce). Toggled by the Tanks button in ControlPanel.
   */
  tankMode: boolean;
}
