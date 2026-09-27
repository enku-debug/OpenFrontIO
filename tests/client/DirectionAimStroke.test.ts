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
