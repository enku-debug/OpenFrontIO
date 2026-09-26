import { EventBus } from "../../core/EventBus";
import { Controller } from "../Controller";
import {
  CloseViewEvent,
  DirectionAimCancelEvent,
  DirectionAimCompleteEvent,
  DirectionAimUpdateEvent,
} from "../InputHandler";
import { TransformHandler } from "../TransformHandler";
import { SendAttackIntentEvent } from "../Transport";
import { UIState } from "../UIState";
import { GameView } from "../view";

// Leave room at the tip of the line for the arrowhead so it doesn't overlap.
const ARROWHEAD_SIZE_PX = 11;
// Below this on-screen drag length, don't bother drawing anything yet.
const MIN_VISIBLE_DRAG_PX = 4;

/**
 * Controller for the "aim & attack" drag gesture (uiState.directionalAimMode,
 * toggled by the button in ControlPanel). While active, InputHandler routes
 * single-pointer drags to the DirectionAim* events (instead of panning the
 * camera); this controller draws the arrow and, on release, fires an attack
 * aimed at the arrow's tip using the same "click = target + direction" path
 * as an ordinary attack click (ClientGameRunner.inputEvent /
 * doGroundAttackUnderCursor), so the existing directionTile plumbing in
 * AttackExecution does the actual aiming.
 *
 * Purely a state + input controller: the arrow is a screen-space DOM overlay
 * (mirrors WarshipSelectionController's drag-rectangle), not a canvas draw.
 */
export class DirectionAimController implements Controller {
  private lineEl: HTMLDivElement | null = null;
  private headEl: HTMLDivElement | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
    private uiState: UIState,
  ) {}

  init() {
    this.ensureArrowEls();
    this.eventBus.on(DirectionAimUpdateEvent, (e) => {
      this.updateArrow(e.startX, e.startY, e.endX, e.endY);
    });
    this.eventBus.on(DirectionAimCompleteEvent, (e) => {
      this.hideArrow();
      this.fireDirectedAttack(e.endX, e.endY);
    });
    this.eventBus.on(DirectionAimCancelEvent, () => this.hideArrow());
    // Aim mode can be left on across menu opens/game exit; don't leave a
    // stale arrow on screen.
    this.eventBus.on(CloseViewEvent, () => this.hideArrow());
  }

  /** Lazily create the two screen-space overlay elements (line + arrowhead). */
  private ensureArrowEls(): void {
    if (this.lineEl !== null) return;

    const line = document.createElement("div");
    line.id = "direction-aim-line";
    line.style.position = "fixed";
    line.style.pointerEvents = "none";
    line.style.display = "none";
    line.style.zIndex = "30";
    line.style.height = "3px";
    line.style.borderRadius = "2px";
    line.style.transformOrigin = "0 50%";
    document.body.appendChild(line);
    this.lineEl = line;

    const head = document.createElement("div");
    head.id = "direction-aim-head";
    head.style.position = "fixed";
    head.style.pointerEvents = "none";
    head.style.display = "none";
    head.style.zIndex = "30";
    head.style.width = "0";
    head.style.height = "0";
    head.style.borderStyle = "solid";
    head.style.transformOrigin = "0 50%";
    document.body.appendChild(head);
    this.headEl = head;
  }

  private updateArrow(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): void {
    const line = this.lineEl;
    const head = this.headEl;
    if (line === null || head === null) return;

    const dx = endX - startX;
    const dy = endY - startY;
    const dist = Math.hypot(dx, dy);
    if (dist < MIN_VISIBLE_DRAG_PX) {
      line.style.display = "none";
      head.style.display = "none";
      return;
    }
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

    // Tint the arrow with the local player's territory color, like the
    // warship selection drag rectangle, so it reads as "yours".
    const myPlayer = this.game.myPlayer();
    const base = myPlayer ? myPlayer.territoryColor().lighten(0.25) : null;
    const color = base
      ? base.alpha(0.9).toRgbString()
      : "rgba(255, 120, 80, 0.9)";

    line.style.left = `${startX}px`;
    line.style.top = `${startY}px`;
    line.style.width = `${Math.max(0, dist - ARROWHEAD_SIZE_PX)}px`;
    line.style.backgroundColor = color;
    line.style.transform = `rotate(${angleDeg}deg)`;
    line.style.display = "block";

    head.style.left = `${endX}px`;
    head.style.top = `${endY}px`;
    head.style.borderWidth = `${ARROWHEAD_SIZE_PX}px 0 ${ARROWHEAD_SIZE_PX}px ${
      ARROWHEAD_SIZE_PX * 1.4
    }px`;
    head.style.borderColor = `transparent transparent transparent ${color}`;
    head.style.transform = `translate(-3px, -${ARROWHEAD_SIZE_PX}px) rotate(${angleDeg}deg)`;
    head.style.display = "block";
  }

  private hideArrow(): void {
    if (this.lineEl !== null) this.lineEl.style.display = "none";
    if (this.headEl !== null) this.headEl.style.display = "none";
  }

  /**
   * Resolve the world tile under the arrow's tip and, if it's attackable
   * (same check as an ordinary attack click), fire an attack targeting its
   * owner and aimed at that tile — identical semantics to clicking there,
   * just reached by drawing an arrow instead of an instant click.
   */
  private fireDirectedAttack(screenX: number, screenY: number): void {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer || !myPlayer.isAlive() || this.game.inSpawnPhase()) return;

    const cell = this.transformHandler.screenToWorldCoordinates(
      screenX,
      screenY,
    );
    if (!this.game.isValidCoord(cell.x, cell.y)) return;
    const tile = this.game.ref(cell.x, cell.y);

    myPlayer
      .actions(tile, null)
      .then((actions) => {
        if (!actions.canAttack) return;
        this.eventBus.emit(
          new SendAttackIntentEvent(
            this.game.owner(tile).id(),
            myPlayer.troops() * this.uiState.attackRatio,
            tile,
          ),
        );
      })
      .catch((error) => {
        console.warn("Failed to check directional-aim attack actions:", error);
      });
  }
}
