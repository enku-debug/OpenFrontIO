import { EventBus } from "../../core/EventBus";
import { Cell } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { AIM_MAX_VIA } from "../../core/Schemas";
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
// The drawn line is followed to within this many tiles...
const LINE_TOLERANCE_TILES = 1.2;
// ...but never finer than this on screen, so mouse jitter doesn't count
// when zoomed far out.
const LINE_TOLERANCE_MIN_PX = 3;
// Ignore pointer moves smaller than this when recording the stroke.
const STROKE_STEP_PX = 3;
// If the line starts outside your land, the attack starts from your nearest
// tile within this many tiles, joined to the line's start.
const CONNECT_MAX_TILES = 150;
// A nearest own tile this close just replaces the start instead of adding
// a tiny extra leg.
const CONNECT_MERGE_TILES = 2;
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

/** A resolved line in world tiles, ready to send. */
interface Aim {
  // start (your own land when possible), points along the line..., tip
  path: TileRef[];
  // The same line in world coordinates (sub-tile), for drawing.
  display: Pt[];
  target: TileRef; // first enemy / unclaimed land tile along the path
}

/** The aimed attack currently running, drawn as a clickable arrow. */
interface ActiveAim {
  path: TileRef[];
  display: Pt[];
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
 *  - records the whole stroke in world coordinates and follows it as a
 *    freehand line: simplified to within LINE_TOLERANCE_TILES using up to
 *    AIM_MAX_VIA points in between, so curves and turns are kept;
 *  - if the line starts outside your land, starts it from your nearest
 *    tile instead, so the attack runs from your border to the line;
 *  - draws that line while dragging, labelled with who it will hit;
 *  - on release, finds the first enemy (or unclaimed) land along it and
 *    sends an attack whose corridor follows it (aimFrom -> aimVia ->
 *    direction), so only the border along the line advances, pushing on
 *    along it (AttackExecution.aimSegmentOf / aimRemaining);
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
  // The drag in progress: where it started on screen (to tell strokes
  // apart), the last recorded screen point, and the stroke in world coords.
  private strokeStart: Pt | null = null;
  private strokeLast: Pt | null = null;
  private stroke: Pt[] = [];
  // Nearest own tile for the current stroke's start (see connectStart).
  private connectCache: { start: TileRef; result: TileRef | null } | null =
    null;

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
      this.resetStroke();
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

  private resetStroke() {
    this.strokeStart = null;
    this.strokeLast = null;
    this.stroke = [];
    this.connectCache = null;
  }

  /** Add a pointer position to the stroke, starting a new one if needed. */
  private record(sx: number, sy: number, ex: number, ey: number) {
    const start = this.strokeStart;
    if (start === null || start.x !== sx || start.y !== sy) {
      this.resetStroke();
      this.strokeStart = { x: sx, y: sy };
      this.strokeLast = { x: sx, y: sy };
      this.stroke = [this.toWorld(sx, sy)];
    }
    const last = this.strokeLast!;
    const end = this.toWorld(ex, ey);
    if (Math.hypot(ex - last.x, ey - last.y) >= STROKE_STEP_PX) {
      this.strokeLast = { x: ex, y: ey };
      this.stroke.push(end);
    } else if (this.stroke.length > 1) {
      // Keep the live end exact without growing the stroke.
      this.stroke[this.stroke.length - 1] = end;
    }
  }

  /** The stroke so far as a followable line (world coords). */
  private strokeLine(): Pt[] {
    const tol = Math.max(
      LINE_TOLERANCE_TILES,
      LINE_TOLERANCE_MIN_PX / this.transformHandler.scale,
    );
    return simplifyStroke(this.stroke, AIM_MAX_VIA, tol);
  }

  private onDragUpdate(sx: number, sy: number, ex: number, ey: number) {
    if (this.drag === null) return;
    this.record(sx, sy, ex, ey);
    if (Math.hypot(ex - sx, ey - sy) < MIN_VISIBLE_DRAG_PX) {
      this.hide(this.drag);
      return;
    }
    this.cancelDragFade();
    const line = this.strokeLine();
    const aim = this.resolveAim(line);
    const pts = (aim === null ? line : aim.display).map((p) =>
      this.worldToScreen(p),
    );
    this.drawPath(this.drag, pts, this.playerColor(0.9));
    this.setLabel(
      this.drag,
      aim === null ? "" : `→ ${this.targetName(aim.target)}`,
      pts,
    );
  }

  private onDragComplete(sx: number, sy: number, ex: number, ey: number) {
    this.record(sx, sy, ex, ey);
    const line = this.strokeLine();
    const aim = this.resolveAim(line);
    this.resetStroke();
    if (aim === null) {
      this.failPath(line.map((p) => this.worldToScreen(p)));
      return;
    }
    this.hide(this.drag);
    this.send(aim);
  }

  // ------------------------------------------------------------- sending

  private send(aim: Aim) {
    const screenPath = aim.display.map((p) => this.worldToScreen(p));
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
          display: aim.display,
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
    this.send({
      path: this.active.path,
      display: this.active.display,
      target,
    });
  }

  // ------------------------------------------------------ aim resolution

  /** Turn a world-space line into tiles, or null if nothing to hit. */
  private resolveAim(line: Pt[]): Aim | null {
    const me = this.game.myPlayer();
    if (me === null || line.length < 2) return null;
    const tiles: TileRef[] = [];
    const display: Pt[] = [];
    for (const p of line) {
      const t = this.worldToTile(p);
      if (t === null) return null;
      if (tiles[tiles.length - 1] === t) continue;
      tiles.push(t);
      display.push(p);
    }
    if (tiles.length < 2) return null;
    // Started outside your land: run from your nearest tile to the line.
    const own = this.connectStart(tiles[0], me.smallID());
    if (own !== null && own !== tiles[0]) {
      const dist = Math.hypot(
        this.game.x(own) - this.game.x(tiles[0]),
        this.game.y(own) - this.game.y(tiles[0]),
      );
      const center = { x: this.game.x(own) + 0.5, y: this.game.y(own) + 0.5 };
      if (dist <= CONNECT_MERGE_TILES) {
        tiles[0] = own;
        display[0] = center;
      } else {
        tiles.unshift(own);
        display.unshift(center);
      }
    }
    const target = this.findTarget(tiles);
    return target === null ? null : { path: tiles, display, target };
  }

  /**
   * The line's start if it is yours, else your nearest tile within
   * CONNECT_MAX_TILES of it (null if none). Cached for the stroke, since the
   * start doesn't move while dragging.
   */
  private connectStart(start: TileRef, mine: number): TileRef | null {
    if (this.game.ownerID(start) === mine) return start;
    const cache = this.connectCache;
    if (cache !== null && cache.start === start) return cache.result;
    const sx = this.game.x(start);
    const sy = this.game.y(start);
    let best: TileRef | null = null;
    let bestD2 = Infinity;
    // Grow square rings until one can't hold anything nearer than the best.
    for (let r = 1; r <= CONNECT_MAX_TILES && r * r <= bestD2; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const edge = dy === -r || dy === r;
        for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r) {
          const x = sx + dx;
          const y = sy + dy;
          if (!this.game.isValidCoord(x, y)) continue;
          const t = this.game.ref(x, y);
          if (this.game.ownerID(t) !== mine) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = t;
          }
        }
      }
    }
    this.connectCache = { start, result: best };
    return best;
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

  private toWorld(sx: number, sy: number): Pt {
    return this.transformHandler.screenToWorldCoordinatesFloat(sx, sy);
  }

  private worldToTile(p: Pt): TileRef | null {
    const cx = Math.min(Math.max(Math.floor(p.x), 0), this.game.width() - 1);
    const cy = Math.min(Math.max(Math.floor(p.y), 0), this.game.height() - 1);
    return this.game.isValidCoord(cx, cy) ? this.game.ref(cx, cy) : null;
  }

  private worldToScreen(p: Pt): Pt {
    return this.transformHandler.worldToScreenCoordinates(new Cell(p.x, p.y));
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
      const pts = this.active.display.map((p) => this.worldToScreen(p));
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
 * from the current path, while that is at least `tolerance` away (same
 * units as the points). A roughly straight stroke stays a single segment;
 * a curve keeps as many points as it needs, up to the limit.
 */
export function simplifyStroke(
  stroke: Pt[],
  maxSegments: number,
  tolerance: number,
): Pt[] {
  const n = stroke.length;
  if (n < 2) return stroke.slice();
  const keep = [0, n - 1];
  while (keep.length - 1 < maxSegments) {
    let bestIdx = -1;
    let bestDist = tolerance;
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
