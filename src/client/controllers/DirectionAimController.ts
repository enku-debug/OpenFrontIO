import { EventBus } from "../../core/EventBus";
import { Cell } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
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
import { renderTroops, translateText } from "../Utils";
import { GameView } from "../view";

// Arrowhead size in px (the line stops short of the tip by about this much).
const HEAD_PX = 11;
// Below this on-screen drag length, don't draw anything yet.
const MIN_VISIBLE_DRAG_PX = 4;
// If the drag starts outside your land, look this far back along the arrow
// for your own territory so the corridor starts at your border.
const SNAP_BACK_MAX_TILES = 400;
// Keep looking for enemy land this far past the arrow's tip.
const TARGET_SEARCH_EXTRA_TILES = 80;
// After a wave is sent, give the simulation this long to create the attack
// before a missing attack is taken to mean "it's over".
const KEEP_ALIVE_MS = 2500;

const FAIL_COLOR = "rgba(239, 68, 68, 0.9)";

interface ArrowEls {
  line: HTMLDivElement;
  head: HTMLDivElement;
  label: HTMLDivElement;
}

/** A resolved arrow in world tiles, ready to send. */
interface Aim {
  from: TileRef; // arrow start, snapped into your own land when possible
  tip: TileRef; // where the player released
  target: TileRef; // first enemy / unclaimed land tile along the arrow
}

/** The aimed attack currently running, drawn as a clickable arrow. */
interface ActiveAim {
  from: TileRef;
  tip: TileRef;
  targetID: string | null; // null = unclaimed land
  targetSmallID: number;
  waves: number;
  lastSentAt: number;
}

/**
 * The "Aim" attack (uiState.directionalAimMode, toggled in ControlPanel).
 *
 * While aim mode is on, InputHandler turns single-pointer drags into the
 * DirectionAim* events instead of panning. This controller:
 *  - draws the arrow while dragging, labelled with who it will hit;
 *  - on release, finds the first enemy (or unclaimed) land the arrow
 *    crosses and sends an attack with the arrow as a corridor (aimFrom ->
 *    direction), so only the border along the arrow advances
 *    (AttackExecution.inAimCorridor);
 *  - keeps that arrow on the map while the attack runs. Clicking it sends
 *    another wave (attack ratio of current troops) into the same corridor;
 *    the simulation merges it into the running attack.
 *
 * All drawing is screen-space DOM, like WarshipSelectionController's
 * drag rectangle; the live arrow is re-projected every frame so it stays
 * pinned to the map while the camera moves.
 */
export class DirectionAimController implements Controller {
  private drag: ArrowEls | null = null;
  private live: ArrowEls | null = null;
  private active: ActiveAim | null = null;
  private rafId: number | null = null;
  private dragFadeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
    private uiState: UIState,
  ) {}

  init() {
    this.drag = this.createArrow("direction-aim-drag", false);
    this.live = this.createArrow("direction-aim-live", true);

    this.eventBus.on(DirectionAimUpdateEvent, (e) =>
      this.onDragUpdate(e.startX, e.startY, e.endX, e.endY),
    );
    this.eventBus.on(DirectionAimCompleteEvent, (e) =>
      this.onDragComplete(e.startX, e.startY, e.endX, e.endY),
    );
    this.eventBus.on(DirectionAimCancelEvent, () => this.hide(this.drag));
    this.eventBus.on(CloseViewEvent, () => this.hide(this.drag));

    // Any other attack order on the same target (a plain click, the radial
    // menu) replaces the corridor in the simulation, so drop our arrow too.
    this.eventBus.on(SendAttackIntentEvent, (e) => {
      if (this.active === null || e.aimFrom !== null) return;
      if (e.targetID === this.active.targetID) {
        this.clearActive();
      }
    });
  }

  tick() {
    if (this.active === null) return;
    const me = this.game.myPlayer();
    if (me === null || !me.isAlive()) {
      this.clearActive();
      return;
    }
    if (performance.now() - this.active.lastSentAt < KEEP_ALIVE_MS) return;
    if (this.activeAttackTroops() === null) {
      this.clearActive();
    }
  }

  // ---------------------------------------------------------------- dragging

  private onDragUpdate(sx: number, sy: number, ex: number, ey: number) {
    if (this.drag === null) return;
    if (Math.hypot(ex - sx, ey - sy) < MIN_VISIBLE_DRAG_PX) {
      this.hide(this.drag);
      return;
    }
    this.cancelDragFade();
    const aim = this.resolveAim(sx, sy, ex, ey);
    this.drawArrow(this.drag, sx, sy, ex, ey, this.playerColor(0.9));
    this.setLabel(
      this.drag,
      aim === null ? "" : `→ ${this.targetName(aim.target)}`,
      sx,
      sy,
      ex,
      ey,
    );
  }

  private onDragComplete(sx: number, sy: number, ex: number, ey: number) {
    const aim = this.resolveAim(sx, sy, ex, ey);
    if (aim === null) {
      this.failDrag(sx, sy, ex, ey);
      return;
    }
    this.hide(this.drag);
    this.send(aim, sx, sy, ex, ey);
  }

  // ------------------------------------------------------------- sending

  private send(aim: Aim, sx: number, sy: number, ex: number, ey: number) {
    const me = this.game.myPlayer();
    if (me === null || !me.isAlive() || this.game.inSpawnPhase()) return;
    me.actions(aim.target, null)
      .then((actions) => {
        if (!actions.canAttack) {
          this.failDrag(sx, sy, ex, ey);
          return;
        }
        const owner = this.game.owner(aim.target);
        const troops = me.troops() * this.uiState.attackRatio;
        this.eventBus.emit(
          new SendAttackIntentEvent(owner.id(), troops, aim.tip, aim.from),
        );

        const sameCorridor =
          this.active !== null && this.active.targetSmallID === owner.smallID();
        this.active = {
          from: aim.from,
          tip: aim.tip,
          targetID: owner.id(),
          targetSmallID: owner.smallID(),
          waves: sameCorridor ? this.active!.waves + 1 : 1,
          lastSentAt: performance.now(),
        };
        this.startLoop();
        this.floatText(`+${renderTroops(troops)}`, ex, ey);
      })
      .catch((error) => {
        console.warn("Failed to check aimed attack actions:", error);
      });
  }

  /** Clicking the live arrow: one more wave along the same corridor. */
  private sendAnotherWave() {
    if (this.active === null) return;
    const tip = this.tileToScreen(this.active.tip);
    const from = this.tileToScreen(this.active.from);
    // Re-resolve from the stored tiles: the spearhead may have moved the
    // first enemy tile further along the arrow since the last wave.
    const target = this.findTarget(this.active.from, this.active.tip);
    if (target === null) {
      this.clearActive();
      return;
    }
    this.send(
      { from: this.active.from, tip: this.active.tip, target },
      from.x,
      from.y,
      tip.x,
      tip.y,
    );
  }

  // ------------------------------------------------------ aim resolution

  /** Turn a screen-space drag into world tiles, or null if nothing to hit. */
  private resolveAim(
    sx: number,
    sy: number,
    ex: number,
    ey: number,
  ): Aim | null {
    const me = this.game.myPlayer();
    if (me === null) return null;
    const start = this.screenToTile(sx, sy);
    const tip = this.screenToTile(ex, ey);
    if (start === null || tip === null || start === tip) return null;
    const from = this.snapIntoOwnLand(start, tip, me.smallID());
    const target = this.findTarget(from, tip);
    return target === null ? null : { from, tip, target };
  }

  /**
   * If the arrow starts outside your land, walk back from its start (away
   * from the tip) to the nearest tile you own, so the corridor begins at
   * your border. Unchanged if none is found.
   */
  private snapIntoOwnLand(start: TileRef, tip: TileRef, mine: number) {
    if (this.game.ownerID(start) === mine) return start;
    const [ux, uy] = this.unit(start, tip);
    const x0 = this.game.x(start) + 0.5;
    const y0 = this.game.y(start) + 0.5;
    for (let d = 0.5; d <= SNAP_BACK_MAX_TILES; d += 0.5) {
      const x = Math.floor(x0 - ux * d);
      const y = Math.floor(y0 - uy * d);
      if (!this.game.isValidCoord(x, y)) break;
      const t = this.game.ref(x, y);
      if (this.game.ownerID(t) === mine) return t;
    }
    return start;
  }

  /** First land tile along the arrow (and a bit beyond) that isn't yours. */
  private findTarget(from: TileRef, tip: TileRef): TileRef | null {
    const me = this.game.myPlayer();
    if (me === null) return null;
    const mine = me.smallID();
    const [ux, uy] = this.unit(from, tip);
    const x0 = this.game.x(from) + 0.5;
    const y0 = this.game.y(from) + 0.5;
    const len = Math.hypot(
      this.game.x(tip) - this.game.x(from),
      this.game.y(tip) - this.game.y(from),
    );
    for (let d = 0; d <= len + TARGET_SEARCH_EXTRA_TILES; d += 0.5) {
      const x = Math.floor(x0 + ux * d);
      const y = Math.floor(y0 + uy * d);
      if (!this.game.isValidCoord(x, y)) break;
      const t = this.game.ref(x, y);
      if (!this.game.isLand(t) || this.game.ownerID(t) === mine) continue;
      return t;
    }
    return null;
  }

  private unit(a: TileRef, b: TileRef): [number, number] {
    const dx = this.game.x(b) - this.game.x(a);
    const dy = this.game.y(b) - this.game.y(a);
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }

  private screenToTile(x: number, y: number): TileRef | null {
    const cell = this.transformHandler.screenToWorldCoordinates(x, y);
    const cx = Math.min(Math.max(cell.x, 0), this.game.width() - 1);
    const cy = Math.min(Math.max(cell.y, 0), this.game.height() - 1);
    return this.game.isValidCoord(cx, cy) ? this.game.ref(cx, cy) : null;
  }

  private tileToScreen(t: TileRef): { x: number; y: number } {
    return this.transformHandler.worldToScreenCoordinates(
      new Cell(this.game.x(t) + 0.5, this.game.y(t) + 0.5),
    );
  }

  private targetName(t: TileRef): string {
    const owner = this.game.owner(t);
    return owner.isPlayer()
      ? owner.displayName()
      : translateText("help_modal.ui_wilderness");
  }

  // ------------------------------------------------------ the live arrow

  /** Troops in the running aimed attack, or null if it has ended. */
  private activeAttackTroops(): number | null {
    const me = this.game.myPlayer();
    if (me === null || this.active === null) return null;
    const attack = me
      .outgoingAttacks()
      .find((a) => a.targetID === this.active!.targetSmallID && !a.retreating);
    return attack === undefined ? null : attack.troops;
  }

  private startLoop() {
    if (this.rafId !== null) return;
    const frame = () => {
      this.rafId = null;
      if (this.active === null || this.live === null) {
        this.hide(this.live);
        return;
      }
      const a = this.tileToScreen(this.active.from);
      const b = this.tileToScreen(this.active.tip);
      this.drawArrow(this.live, a.x, a.y, b.x, b.y, this.playerColor(0.75));
      const troops = this.activeAttackTroops();
      this.setLabel(
        this.live,
        `×${this.active.waves}${troops === null ? "" : ` · ${renderTroops(troops)}`}  +`,
        a.x,
        a.y,
        b.x,
        b.y,
      );
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private clearActive() {
    this.active = null;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.hide(this.live);
  }

  // ------------------------------------------------------------- drawing

  private createArrow(id: string, clickable: boolean): ArrowEls {
    const base = (el: HTMLDivElement) => {
      el.style.position = "fixed";
      el.style.left = "0";
      el.style.top = "0";
      el.style.display = "none";
      el.style.zIndex = "30";
      el.style.pointerEvents = "none";
      return el;
    };

    const line = base(document.createElement("div"));
    line.id = `${id}-line`;
    line.style.height = "3px";
    line.style.borderRadius = "2px";
    line.style.transformOrigin = "0 50%";
    // Thin dark outline so pale territory colours still read on snow/sand.
    line.style.boxShadow = "0 0 0 1px rgba(0, 0, 0, 0.35)";

    const head = base(document.createElement("div"));
    head.id = `${id}-head`;
    head.style.width = "0";
    head.style.height = "0";
    head.style.borderStyle = "solid";
    head.style.transformOrigin = "0 50%";
    head.style.filter = "drop-shadow(0 0 1px rgba(0, 0, 0, 0.7))";

    const label = base(document.createElement("div"));
    label.id = `${id}-label`;
    label.style.whiteSpace = "nowrap";
    label.style.font = "600 12px/1.2 system-ui, sans-serif";
    label.style.color = "#fff";
    label.style.padding = "3px 7px";
    label.style.borderRadius = "8px";
    label.style.background = "rgba(16, 18, 22, 0.85)";
    label.style.boxShadow = "inset 0 0 0 1px rgba(255, 255, 255, 0.12)";
    label.style.transition = "opacity 0.5s";

    if (clickable) {
      const tip = translateText("control_panel.aim_add_wave");
      for (const el of [head, label]) {
        el.style.pointerEvents = "auto";
        el.style.cursor = "pointer";
        el.title = tip;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.sendAnotherWave();
        });
      }
    }

    document.body.append(line, head, label);
    return { line, head, label };
  }

  private drawArrow(
    els: ArrowEls,
    sx: number,
    sy: number,
    ex: number,
    ey: number,
    color: string,
  ) {
    const dist = Math.hypot(ex - sx, ey - sy);
    const angle = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI;
    const { line, head } = els;
    line.style.width = `${Math.max(0, dist - HEAD_PX)}px`;
    line.style.backgroundColor = color;
    line.style.transform = `translate(${sx}px, ${sy - 1.5}px) rotate(${angle}deg)`;
    line.style.display = "block";

    head.style.borderWidth = `${HEAD_PX}px 0 ${HEAD_PX}px ${HEAD_PX * 1.4}px`;
    head.style.borderColor = `transparent transparent transparent ${color}`;
    head.style.transform = `translate(${ex - 3}px, ${ey - HEAD_PX}px) rotate(${angle}deg)`;
    head.style.display = "block";
  }

  /** Put `text` just past the arrow's tip (hidden when empty). */
  private setLabel(
    els: ArrowEls,
    text: string,
    sx: number,
    sy: number,
    ex: number,
    ey: number,
  ) {
    const { label } = els;
    if (text === "") {
      label.style.display = "none";
      return;
    }
    const dist = Math.hypot(ex - sx, ey - sy) || 1;
    const off = HEAD_PX * 1.4 + 16;
    const lx = ex + ((ex - sx) / dist) * off;
    const ly = ey + ((ey - sy) / dist) * off;
    if (label.textContent !== text) label.textContent = text;
    label.style.transform = `translate(${lx}px, ${ly}px) translate(-50%, -50%)`;
    label.style.opacity = "1";
    label.style.display = "block";
  }

  /** Nothing to attack along this arrow: flash it red, then fade out. */
  private failDrag(sx: number, sy: number, ex: number, ey: number) {
    if (this.drag === null) return;
    this.drawArrow(this.drag, sx, sy, ex, ey, FAIL_COLOR);
    this.setLabel(
      this.drag,
      translateText("control_panel.aim_no_target"),
      sx,
      sy,
      ex,
      ey,
    );
    this.cancelDragFade();
    this.dragFadeTimer = setTimeout(() => {
      this.dragFadeTimer = null;
      this.hide(this.drag);
    }, 900);
  }

  private cancelDragFade() {
    if (this.dragFadeTimer !== null) {
      clearTimeout(this.dragFadeTimer);
      this.dragFadeTimer = null;
    }
  }

  /** A short "+12.3K" that drifts up from (x, y) and fades. */
  private floatText(text: string, x: number, y: number) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.position = "fixed";
    el.style.left = "0";
    el.style.top = "0";
    el.style.zIndex = "31";
    el.style.pointerEvents = "none";
    el.style.font = "700 14px/1 system-ui, sans-serif";
    el.style.color = "#fff";
    el.style.textShadow = "0 1px 3px rgba(0, 0, 0, 0.8)";
    el.style.transform = `translate(${x}px, ${y - 18}px) translate(-50%, -50%)`;
    el.style.transition = "transform 0.9s ease-out, opacity 0.9s ease-out";
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = `translate(${x}px, ${y - 46}px) translate(-50%, -50%)`;
      el.style.opacity = "0";
    });
    setTimeout(() => el.remove(), 1000);
  }

  private hide(els: ArrowEls | null) {
    if (els === null) return;
    els.line.style.display = "none";
    els.head.style.display = "none";
    els.label.style.display = "none";
  }

  private playerColor(alpha: number): string {
    const me = this.game.myPlayer();
    return me
      ? me.territoryColor().lighten(0.25).alpha(alpha).toRgbString()
      : `rgba(255, 120, 80, ${alpha})`;
  }
}
