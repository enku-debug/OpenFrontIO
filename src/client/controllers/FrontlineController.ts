import { EventBus } from "../../core/EventBus";
import {
  frontlineNodeTiles,
  isFrontlineNodeTile,
} from "../../core/game/Frontline";
import { Cell, UnitType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { FRONTLINE_MAX_POINTS } from "../../core/Schemas";
import { Controller } from "../Controller";
import {
  CloseViewEvent,
  FrontlineDrawCompleteEvent,
  FrontlineDrawUpdateEvent,
} from "../InputHandler";
import { TransformHandler } from "../TransformHandler";
import {
  BuildUnitIntentEvent,
  SendBuildFrontlineIntentEvent,
} from "../Transport";
import { UIState } from "../UIState";
import { renderNumber, translateText } from "../Utils";
import { GameView } from "../view";
import { simplifyStroke } from "./DirectionAimController";

const SVG_NS = "http://www.w3.org/2000/svg";
// Ignore pointer moves smaller than this when recording the stroke.
const STROKE_STEP_PX = 3;
// The drawn line is followed to within this many tiles.
const LINE_TOLERANCE_TILES = 1;
const OK_COLOR = "#4ade80";
const BAD_COLOR = "rgba(239, 68, 68, 0.95)";
// How long a line that built nothing stays on screen (red).
const FAIL_MS = 700;

interface Pt {
  x: number;
  y: number;
}

/** A drawn line resolved into Frontline nodes. */
interface Plan {
  path: TileRef[]; // tiles along the line, sent as the intent
  line: Pt[]; // the same line in world coords, for drawing
  nodes: { tile: TileRef; ok: boolean }[];
}

/**
 * Drawing a Frontline. Picking Frontline (build bar, hotkey X, either build
 * menu) sets uiState.ghostStructure to it; InputHandler then turns
 * single-pointer drags into FrontlineDraw* events instead of panning. This
 * controller records the stroke, previews where the nodes go (green: will
 * be built, red: not on your land near the border, or next to an existing
 * node), and on release sends a build_frontline intent and leaves drawing.
 * The simulation (FrontlineExecution) decides the real nodes the same way.
 */
export class FrontlineController implements Controller {
  private svg: SVGSVGElement | null = null;
  private outline: SVGPolylineElement | null = null;
  private line: SVGPolylineElement | null = null;
  private dots: SVGGElement | null = null;
  private label: HTMLDivElement | null = null;
  private strokeStart: Pt | null = null;
  private strokeLast: Pt | null = null;
  private stroke: Pt[] = [];
  private failTimer: ReturnType<typeof setTimeout> | null = null;
  private nodeCost: bigint | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
    private uiState: UIState,
  ) {}

  init() {
    this.createOverlay();
    this.eventBus.on(FrontlineDrawUpdateEvent, (e) =>
      this.onUpdate(e.startX, e.startY, e.endX, e.endY),
    );
    this.eventBus.on(FrontlineDrawCompleteEvent, (e) =>
      this.onComplete(e.startX, e.startY, e.endX, e.endY),
    );
    this.eventBus.on(CloseViewEvent, () => {
      this.resetStroke();
      this.hide();
    });
    // The build menus' Frontline entry: start drawing instead of placing.
    this.eventBus.on(BuildUnitIntentEvent, (e) => {
      if (e.unit === UnitType.Frontline) {
        this.uiState.ghostStructure = UnitType.Frontline;
      }
    });
  }

  tick() {
    if (
      this.uiState.ghostStructure !== UnitType.Frontline &&
      this.stroke.length > 0
    ) {
      this.resetStroke();
      this.hide();
    }
  }

  // ---------------------------------------------------------------- stroke

  private resetStroke() {
    this.strokeStart = null;
    this.strokeLast = null;
    this.stroke = [];
  }

  private record(sx: number, sy: number, ex: number, ey: number) {
    const start = this.strokeStart;
    if (start === null || start.x !== sx || start.y !== sy) {
      this.resetStroke();
      this.strokeStart = { x: sx, y: sy };
      this.strokeLast = { x: sx, y: sy };
      this.stroke = [this.toWorld(sx, sy)];
      this.fetchNodeCost();
    }
    const last = this.strokeLast!;
    const end = this.toWorld(ex, ey);
    if (Math.hypot(ex - last.x, ey - last.y) >= STROKE_STEP_PX) {
      this.strokeLast = { x: ex, y: ey };
      this.stroke.push(end);
    } else if (this.stroke.length > 1) {
      this.stroke[this.stroke.length - 1] = end;
    }
  }

  private fetchNodeCost() {
    const me = this.game.myPlayer();
    if (me === null) return;
    me.buildables(undefined, [UnitType.Frontline]).then((bs) => {
      const b = bs.find((u) => u.type === UnitType.Frontline);
      if (b !== undefined) this.nodeCost = b.cost;
    });
  }

  private plan(): Plan | null {
    const me = this.game.myPlayer();
    if (me === null) return null;
    const line = simplifyStroke(
      this.stroke,
      FRONTLINE_MAX_POINTS - 1,
      LINE_TOLERANCE_TILES,
    );
    const path: TileRef[] = [];
    for (const p of line) {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      if (!this.game.isValidCoord(x, y)) continue;
      const t = this.game.ref(x, y);
      if (path[path.length - 1] !== t) path.push(t);
    }
    if (path.length === 0) return null;
    const config = this.game.config();
    const spacing = config.frontlineNodeSpacing();
    const tiles = frontlineNodeTiles(
      this.game,
      path,
      spacing,
      config.frontlineMaxLength(),
    );
    const nodes = tiles.map((tile) => ({
      tile,
      ok:
        isFrontlineNodeTile(
          this.game,
          me.smallID(),
          tile,
          config.frontlineBorderDistance(),
        ) &&
        !this.game.hasUnitNearby(
          tile,
          spacing - 1,
          UnitType.Frontline,
          me.id(),
          true,
        ),
    }));
    // Draw the line only as far as the last node: that's what gets built.
    const lastNode = tiles[tiles.length - 1];
    return { path, line: this.clipLine(line, lastNode), nodes };
  }

  /** `line` up to the point closest to `tile` (world coords). */
  private clipLine(line: Pt[], tile: TileRef): Pt[] {
    const tx = this.game.x(tile) + 0.5;
    const ty = this.game.y(tile) + 0.5;
    let best = line.length - 1;
    let bestD = Infinity;
    for (let i = 0; i < line.length; i++) {
      const d = Math.hypot(line[i].x - tx, line[i].y - ty);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return [...line.slice(0, best + 1), { x: tx, y: ty }];
  }

  private onUpdate(sx: number, sy: number, ex: number, ey: number) {
    this.cancelFail();
    this.record(sx, sy, ex, ey);
    const plan = this.plan();
    if (plan === null) {
      this.hide();
      return;
    }
    this.draw(plan, false);
  }

  private onComplete(sx: number, sy: number, ex: number, ey: number) {
    this.record(sx, sy, ex, ey);
    const plan = this.plan();
    this.resetStroke();
    const me = this.game.myPlayer();
    const okCount = plan?.nodes.filter((n) => n.ok).length ?? 0;
    if (
      plan === null ||
      okCount === 0 ||
      me === null ||
      !me.isAlive() ||
      this.game.inSpawnPhase()
    ) {
      if (plan !== null) this.draw(plan, true);
      this.failTimer = setTimeout(() => this.hide(), FAIL_MS);
      return;
    }
    this.hide();
    this.eventBus.emit(new SendBuildFrontlineIntentEvent(plan.path));
    this.uiState.ghostStructure = null;
  }

  // ----------------------------------------------------------------- drawing

  private toWorld(sx: number, sy: number): Pt {
    return this.transformHandler.screenToWorldCoordinatesFloat(sx, sy);
  }

  private toScreen(p: Pt): Pt {
    return this.transformHandler.worldToScreenCoordinates(new Cell(p.x, p.y));
  }

  private createOverlay() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.id = "frontline-draw-svg";
    Object.assign(svg.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100vw",
      height: "100vh",
      overflow: "visible",
      pointerEvents: "none",
      zIndex: "30",
      display: "none",
    });
    const polyline = (stroke: string, width: number, dash?: string) => {
      const el = document.createElementNS(SVG_NS, "polyline");
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", stroke);
      el.setAttribute("stroke-width", String(width));
      el.setAttribute("stroke-linejoin", "round");
      el.setAttribute("stroke-linecap", "round");
      if (dash !== undefined) el.setAttribute("stroke-dasharray", dash);
      return el;
    };
    this.outline = polyline("rgba(0, 0, 0, 0.4)", 7);
    this.line = polyline("#fff", 4, "10 6");
    this.dots = document.createElementNS(SVG_NS, "g");
    svg.append(this.outline, this.line, this.dots);

    const label = document.createElement("div");
    label.id = "frontline-draw-label";
    Object.assign(label.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "30",
      display: "none",
      pointerEvents: "none",
      whiteSpace: "nowrap",
      font: "600 12px/1.2 system-ui, sans-serif",
      color: "#fff",
      padding: "3px 7px",
      borderRadius: "8px",
      background: "rgba(16, 18, 22, 0.85)",
      boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.12)",
    });
    document.body.append(svg, label);
    this.svg = svg;
    this.label = label;
  }

  private draw(plan: Plan, failed: boolean) {
    if (!this.svg || !this.line || !this.outline || !this.dots || !this.label)
      return;
    const pts = plan.line.map((p) => this.toScreen(p));
    const attr = pts
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    this.outline.setAttribute("points", attr);
    this.line.setAttribute("points", attr);
    this.line.setAttribute("stroke", failed ? BAD_COLOR : "#fff");

    this.dots.replaceChildren();
    for (const n of plan.nodes) {
      const c = this.toScreen({
        x: this.game.x(n.tile) + 0.5,
        y: this.game.y(n.tile) + 0.5,
      });
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", c.x.toFixed(1));
      dot.setAttribute("cy", c.y.toFixed(1));
      dot.setAttribute("r", "6");
      dot.setAttribute("fill", n.ok && !failed ? OK_COLOR : BAD_COLOR);
      dot.setAttribute("stroke", "rgba(0, 0, 0, 0.55)");
      dot.setAttribute("stroke-width", "1.5");
      this.dots.append(dot);
    }
    this.svg.style.display = "block";

    const ok = plan.nodes.filter((n) => n.ok).length;
    const cost =
      this.nodeCost === null
        ? ""
        : ` · ${renderNumber(this.nodeCost * BigInt(ok))}`;
    this.label.textContent = `${translateText("unit_type.frontline")} ×${ok}${cost}`;
    const tip = pts[pts.length - 1];
    this.label.style.transform = `translate(${Math.round(tip.x + 12)}px, ${Math.round(tip.y - 26)}px)`;
    this.label.style.display = "block";
  }

  private cancelFail() {
    if (this.failTimer !== null) {
      clearTimeout(this.failTimer);
      this.failTimer = null;
    }
  }

  private hide() {
    this.cancelFail();
    if (this.svg) this.svg.style.display = "none";
    if (this.label) this.label.style.display = "none";
  }
}
