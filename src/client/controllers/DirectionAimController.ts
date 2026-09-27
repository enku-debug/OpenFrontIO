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

// Arrowhead: length along the path and half its width, in px.
const HEAD_LEN_PX = 15;
const HEAD_HALF_PX = 10;
// Below this on-screen drag length, don't draw anything yet.
const MIN_VISIBLE_DRAG_PX = 4;
// A drawn stroke is simplified to at most this many straight segments
// (must match AIM_MAX_BENDS + 1 in AttackExecution).
const MAX_SEGMENTS = 3;
// A bend is only kept if the stroke strays this far (px) from a straight
// line — ordinary hand wobble stays a single straight arrow.
const BEND_MIN_PX = 22;
// Ignore pointer moves smaller than this when recording the stroke.
const STROKE_STEP_PX = 3;
// If the drag starts outside your land, look this far back along the arrow
// for your own territory so the corridor starts at your border.
const SNAP_BACK_MAX_TILES = 400;
// Keep looking for enemy land this far past the arrow's tip.
const TARGET_SEARCH_EXTRA_TILES = 80;
// After a wave is sent, give the simulation this long to create the attack
// before a missing attack is taken to mean "it's over".
const KEEP_ALIVE_MS = 2500;

const FAIL_COLOR = "rgba(239, 68, 68, 0.9)";
const SVG_NS = "http://www.w3.org/2000/svg";

interface Pt {
  x: number;
  y: number;
}

interface ArrowEls {
  svg: SVGSVGElement;
  outline: SVGPolylineElement;
  line: SVGPolylineElement;
  head: SVGPolygonElement;
  label: HTMLDivElement;
}

/** A resolved arrow in world tiles, ready to send. */
interface Aim {
  // start (snapped into your own land when possible), bends..., tip
  path: TileRef[];
  target: TileRef; // first enemy / unclaimed land tile along the path
}

/** The aimed attack currently running, drawn as a clickable arrow. */
interface ActiveAim {
  path: TileRef[];
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
 *  - records the whole stroke and simplifies it to a path of up to
 *    MAX_SEGMENTS straight segments, so one drag can bend (e.g. right,
 *    then down, then right again); a roughly straight drag stays one
 *    arrow, exactly as before;
 *  - draws that path while dragging, labelled with who it will hit;
 *  - on release, finds the first enemy (or unclaimed) land along the path
 *    and sends an attack whose corridor follows it (aimFrom -> aimVia ->
 *    direction), so only the border along the path advances
 *    (AttackExecution.inAimCorridor);
 *  - keeps the path on the map while the attack runs. Clicking its head or
 *    badge sends another wave (attack ratio of current troops) along the
 *    same path; the simulation merges it into the running attack.
 *
 * Drawing is a screen-space SVG overlay (pointer-events off except the live
 * arrow's head), re-projected every frame so it stays pinned to the map.
 */
export class DirectionAimController implements Controller {
  private drag: ArrowEls | null = null;
  private live: ArrowEls | null = null;
  private active: ActiveAim | null = null;
  private rafId: number | null = null;
  private dragFadeTimer: ReturnType<typeof setTimeout> | null = null;
  // Screen points of the drag in progress; stroke[0] is where it started.
  private stroke: Pt[] = [];

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
    const abort = () => {
      this.stroke = [];
      this.hide(this.drag);
    };
    this.eventBus.on(DirectionAimCancelEvent, abort);
    this.eventBus.on(CloseViewEvent, abort);

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

  /** Add a pointer position to the stroke, starting a new one if needed. */
  private record(sx: number, sy: number, ex: number, ey: number) {
    const first = this.stroke[0];
    if (first === undefined || first.x !== sx || first.y !== sy) {
      this.stroke = [{ x: sx, y: sy }];
    }
    const last = this.stroke[this.stroke.length - 1];
    if (Math.hypot(ex - last.x, ey - last.y) >= STROKE_STEP_PX) {
      this.stroke.push({ x: ex, y: ey });
    } else if (this.stroke.length > 1) {
      // Keep the live end exact without growing the stroke.
      this.stroke[this.stroke.length - 1] = { x: ex, y: ey };
    }
  }

  private onDragUpdate(sx: number, sy: number, ex: number, ey: number) {
    if (this.drag === null) return;
    this.record(sx, sy, ex, ey);
    if (Math.hypot(ex - sx, ey - sy) < MIN_VISIBLE_DRAG_PX) {
      this.hide(this.drag);
      return;
    }
    this.cancelDragFade();
    const screenPath = simplifyStroke(this.stroke, MAX_SEGMENTS, BEND_MIN_PX);
    const aim = this.resolveAim(screenPath);
    this.drawPath(this.drag, screenPath, this.playerColor(0.9));
    this.setLabel(
      this.drag,
      aim === null ? "" : `→ ${this.targetName(aim.target)}`,
      screenPath,
    );
  }

  private onDragComplete(sx: number, sy: number, ex: number, ey: number) {
    this.record(sx, sy, ex, ey);
    const screenPath = simplifyStroke(this.stroke, MAX_SEGMENTS, BEND_MIN_PX);
    this.stroke = [];
    const aim = this.resolveAim(screenPath);
    if (aim === null) {
      this.failPath(screenPath);
      return;
    }
    this.hide(this.drag);
    this.send(aim, screenPath);
  }

  // ------------------------------------------------------------- sending

  private send(aim: Aim, screenPath: Pt[]) {
    const me = this.game.myPlayer();
    if (me === null || !me.isAlive() || this.game.inSpawnPhase()) return;
    me.actions(aim.target, null)
      .then((actions) => {
        if (!actions.canAttack) {
          this.failPath(screenPath);
          return;
        }
        const owner = this.game.owner(aim.target);
        const troops = me.troops() * this.uiState.attackRatio;
        const path = aim.path;
        this.eventBus.emit(
          new SendAttackIntentEvent(
            owner.id(),
            troops,
            path[path.length - 1],
            path[0],
            path.slice(1, -1),
          ),
        );

        const sameTarget =
          this.active !== null && this.active.targetSmallID === owner.smallID();
        this.active = {
          path,
          targetID: owner.id(),
          targetSmallID: owner.smallID(),
          waves: sameTarget ? this.active!.waves + 1 : 1,
          lastSentAt: performance.now(),
        };
        this.startLoop();
        const end = screenPath[screenPath.length - 1];
        this.floatText(`+${renderTroops(troops)}`, end.x, end.y);
      })
      .catch((error) => {
        console.warn("Failed to check aimed attack actions:", error);
      });
  }

  /** Clicking the live arrow: one more wave along the same path. */
  private sendAnotherWave() {
    if (this.active === null) return;
    // Re-resolve along the stored path: the spearhead may have moved the
    // first enemy tile further along since the last wave.
    const target = this.findTarget(this.active.path);
    if (target === null) {
      this.clearActive();
      return;
    }
    this.send(
      { path: this.active.path, target },
      this.active.path.map((t) => this.tileToScreen(t)),
    );
  }

  // ------------------------------------------------------ aim resolution

  /** Turn a screen-space path into world tiles, or null if nothing to hit. */
  private resolveAim(screenPath: Pt[]): Aim | null {
    const me = this.game.myPlayer();
    if (me === null || screenPath.length < 2) return null;
    const tiles: TileRef[] = [];
    for (const p of screenPath) {
      const t = this.screenToTile(p.x, p.y);
      if (t === null) return null;
      if (tiles[tiles.length - 1] !== t) tiles.push(t);
    }
    if (tiles.length < 2) return null;
    tiles[0] = this.snapIntoOwnLand(tiles[0], tiles[1], me.smallID());
    const target = this.findTarget(tiles);
    return target === null ? null : { path: tiles, target };
  }

  /**
   * If the path starts outside your land, walk back from its start (away
   * from the first segment's direction) to the nearest tile you own, so the
   * corridor begins at your border. Unchanged if none is found.
   */
  private snapIntoOwnLand(start: TileRef, next: TileRef, mine: number) {
    if (this.game.ownerID(start) === mine) return start;
    const [ux, uy] = this.unit(start, next);
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

  /** First land tile along the path (and a bit past its tip) not yours. */
  private findTarget(path: TileRef[]): TileRef | null {
    const me = this.game.myPlayer();
    if (me === null) return null;
    const mine = me.smallID();
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const [ux, uy] = this.unit(a, b);
      const x0 = this.game.x(a) + 0.5;
      const y0 = this.game.y(a) + 0.5;
      let len = Math.hypot(
        this.game.x(b) - this.game.x(a),
        this.game.y(b) - this.game.y(a),
      );
      if (i + 2 === path.length) len += TARGET_SEARCH_EXTRA_TILES;
      for (let d = 0; d <= len; d += 0.5) {
        const x = Math.floor(x0 + ux * d);
        const y = Math.floor(y0 + uy * d);
        if (!this.game.isValidCoord(x, y)) break;
        const t = this.game.ref(x, y);
        if (!this.game.isLand(t) || this.game.ownerID(t) === mine) continue;
        return t;
      }
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

  private tileToScreen(t: TileRef): Pt {
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
      const pts = this.active.path.map((t) => this.tileToScreen(t));
      this.drawPath(this.live, pts, this.playerColor(0.75));
      const troops = this.activeAttackTroops();
      this.setLabel(
        this.live,
        `×${this.active.waves}${troops === null ? "" : ` · ${renderTroops(troops)}`}  +`,
        pts,
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
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.id = `${id}-svg`;
    svg.style.position = "fixed";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.width = "100vw";
    svg.style.height = "100vh";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    svg.style.zIndex = "30";
    svg.style.display = "none";

    const polyline = (stroke: string, width: number) => {
      const el = document.createElementNS(SVG_NS, "polyline");
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", stroke);
      el.setAttribute("stroke-width", String(width));
      el.setAttribute("stroke-linejoin", "round");
      el.setAttribute("stroke-linecap", "round");
      return el;
    };
    // Thin dark outline under the line so pale colours still read.
    const outline = polyline("rgba(0, 0, 0, 0.35)", 5);
    const line = polyline("#fff", 3);
    const head = document.createElementNS(SVG_NS, "polygon");
    head.setAttribute("stroke", "rgba(0, 0, 0, 0.45)");
    head.setAttribute("stroke-width", "1");
    head.setAttribute("stroke-linejoin", "round");
    svg.append(outline, line, head);

    const label = document.createElement("div");
    label.id = `${id}-label`;
    label.style.position = "fixed";
    label.style.left = "0";
    label.style.top = "0";
    label.style.zIndex = "30";
    label.style.display = "none";
    label.style.pointerEvents = "none";
    label.style.whiteSpace = "nowrap";
    label.style.font = "600 12px/1.2 system-ui, sans-serif";
    label.style.color = "#fff";
    label.style.padding = "3px 7px";
    label.style.borderRadius = "8px";
    label.style.background = "rgba(16, 18, 22, 0.85)";
    label.style.boxShadow = "inset 0 0 0 1px rgba(255, 255, 255, 0.12)";

    if (clickable) {
      const tip = translateText("control_panel.aim_add_wave");
      const onClick = (ev: Event) => {
        ev.stopPropagation();
        this.sendAnotherWave();
      };
      head.style.pointerEvents = "auto";
      head.style.cursor = "pointer";
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = tip;
      head.appendChild(title);
      head.addEventListener("click", onClick);
      label.style.pointerEvents = "auto";
      label.style.cursor = "pointer";
      label.title = tip;
      label.addEventListener("click", onClick);
    }

    document.body.append(svg, label);
    return { svg, outline, line, head, label };
  }

  /** Draw `pts` (screen px) as a polyline ending in an arrowhead. */
  private drawPath(els: ArrowEls, pts: Pt[], color: string) {
    const n = pts.length;
    if (n < 2) {
      this.hide(els);
      return;
    }
    const tip = pts[n - 1];
    const prev = pts[n - 2];
    const segLen = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
    const ux = (tip.x - prev.x) / segLen;
    const uy = (tip.y - prev.y) / segLen;
    // End the line inside the head so the two join cleanly.
    const back = Math.min(HEAD_LEN_PX * 0.8, segLen);
    const linePts = [
      ...pts.slice(0, n - 1),
      { x: tip.x - ux * back, y: tip.y - uy * back },
    ];
    const asAttr = (ps: Pt[]) =>
      ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    els.outline.setAttribute("points", asAttr(linePts));
    els.line.setAttribute("points", asAttr(linePts));
    els.line.setAttribute("stroke", color);

    const bx = tip.x - ux * HEAD_LEN_PX;
    const by = tip.y - uy * HEAD_LEN_PX;
    els.head.setAttribute(
      "points",
      asAttr([
        tip,
        { x: bx - uy * HEAD_HALF_PX, y: by + ux * HEAD_HALF_PX },
        { x: bx + uy * HEAD_HALF_PX, y: by - ux * HEAD_HALF_PX },
      ]),
    );
    els.head.setAttribute("fill", color);
    els.svg.style.display = "block";
  }

  /** Put `text` just past the path's tip (hidden when empty). */
  private setLabel(els: ArrowEls, text: string, pts: Pt[]) {
    const { label } = els;
    const n = pts.length;
    if (text === "" || n < 2) {
      label.style.display = "none";
      return;
    }
    const tip = pts[n - 1];
    const prev = pts[n - 2];
    const segLen = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
    const off = HEAD_LEN_PX + 18;
    const lx = tip.x + ((tip.x - prev.x) / segLen) * off;
    const ly = tip.y + ((tip.y - prev.y) / segLen) * off;
    if (label.textContent !== text) label.textContent = text;
    label.style.transform = `translate(${lx}px, ${ly}px) translate(-50%, -50%)`;
    label.style.display = "block";
  }

  /** Nothing to attack along this path: flash it red, then clear it. */
  private failPath(screenPath: Pt[]) {
    if (this.drag === null) return;
    this.drawPath(this.drag, screenPath, FAIL_COLOR);
    this.setLabel(
      this.drag,
      translateText("control_panel.aim_no_target"),
      screenPath,
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
    els.svg.style.display = "none";
    els.label.style.display = "none";
  }

  private playerColor(alpha: number): string {
    const me = this.game.myPlayer();
    return me
      ? me.territoryColor().lighten(0.25).alpha(alpha).toRgbString()
      : `rgba(255, 120, 80, ${alpha})`;
  }
}

/**
 * Reduce a hand-drawn stroke to at most `maxSegments` straight segments:
 * start from its two ends and repeatedly add the point that strays furthest
 * from the current path, while that is at least `minBendPx` away. A roughly
 * straight stroke therefore stays a single segment.
 */
export function simplifyStroke(
  stroke: Pt[],
  maxSegments: number,
  minBendPx: number,
): Pt[] {
  const n = stroke.length;
  if (n < 2) return stroke.slice();
  const keep = [0, n - 1];
  while (keep.length - 1 < maxSegments) {
    let bestIdx = -1;
    let bestDist = minBendPx;
    for (let k = 0; k + 1 < keep.length; k++) {
      const a = stroke[keep[k]];
      const b = stroke[keep[k + 1]];
      for (let j = keep[k] + 1; j < keep[k + 1]; j++) {
        const d = distToSegment(stroke[j], a, b);
        if (d >= bestDist) {
          bestDist = d;
          bestIdx = j;
        }
      }
    }
    if (bestIdx === -1) break;
    keep.push(bestIdx);
    keep.sort((x, y) => x - y);
  }
  return keep.map((i) => stroke[i]);
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
  );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
