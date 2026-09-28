import { describe, expect, it } from "vitest";
import { simplifyStroke } from "../../src/client/controllers/DirectionAimController";

// A stroke sampled every 5px along straight legs through the given corners.
function strokeThrough(corners: [number, number][], wobble = 0) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 5);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const w = wobble * Math.sin(pts.length * 1.7); // hand jitter
      pts.push({ x: ax + (bx - ax) * t + w, y: ay + (by - ay) * t - w });
    }
  }
  const [lx, ly] = corners[corners.length - 1];
  pts.push({ x: lx, y: ly });
  return pts;
}

describe("simplifyStroke", () => {
  it("keeps a wobbly straight drag as one straight arrow", () => {
    const path = simplifyStroke(
      strokeThrough(
        [
          [0, 0],
          [300, 40],
        ],
        6,
      ),
      3,
      22,
    );
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 40 },
    ]);
  });

  it("turns an L-shaped drag into two segments bending at the corner", () => {
    const path = simplifyStroke(
      strokeThrough([
        [0, 0],
        [200, 0],
        [200, 150],
      ]),
      3,
      22,
    );
    expect(path).toHaveLength(3);
    expect(path[1].x).toBeCloseTo(200, 0);
    expect(path[1].y).toBeCloseTo(0, 0);
  });

  it("turns a Z-shaped drag into three segments", () => {
    const corners: [number, number][] = [
      [0, 0],
      [200, 0],
      [60, 160],
      [260, 160],
    ];
    const path = simplifyStroke(strokeThrough(corners), 3, 22);
    expect(path).toHaveLength(4);
    path.forEach((p, i) => {
      expect(Math.hypot(p.x - corners[i][0], p.y - corners[i][1])).toBeLessThan(
        6,
      );
    });
  });

  it("follows a curve closely when given room for many points", () => {
    // Half circle of radius 60 (world tiles), sampled every ~1 tile.
    const arc: { x: number; y: number }[] = [];
    for (let k = 0; k <= 180; k++) {
      const a = (Math.PI * k) / 180;
      arc.push({ x: 60 * Math.cos(a), y: 60 * Math.sin(a) });
    }
    const path = simplifyStroke(arc, 30, 1.2);
    expect(path.length).toBeGreaterThan(8);
    expect(path.length).toBeLessThanOrEqual(31);
    expect(path[0]).toEqual(arc[0]);
    expect(path[path.length - 1]).toEqual(arc[arc.length - 1]);
    // Every drawn point stays within the tolerance of the kept line.
    for (const p of arc) {
      let best = Infinity;
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i];
        const b = path[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy),
          ),
        );
        best = Math.min(
          best,
          Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy),
        );
      }
      expect(best).toBeLessThan(1.2);
    }
  });

  it("never makes more than the allowed number of segments", () => {
    const zigzag = strokeThrough([
      [0, 0],
      [100, 100],
      [200, 0],
      [300, 100],
      [400, 0],
      [500, 100],
    ]);
    expect(simplifyStroke(zigzag, 3, 22)).toHaveLength(4);
  });
});
