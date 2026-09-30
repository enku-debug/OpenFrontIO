import { TileRef } from "./GameMap";

/** The bits of the map Frontline geometry needs (Game and GameView both fit). */
export interface TileGrid {
  isValidRef(ref: TileRef): boolean;
  isValidCoord(x: number, y: number): boolean;
  ref(x: number, y: number): TileRef;
  x(ref: TileRef): number;
  y(ref: TileRef): number;
  isLand(ref: TileRef): boolean;
  ownerID(ref: TileRef): number;
}

/**
 * Whether a Frontline node may go on `tile` for the player with `smallID`:
 * their own land within `borderDistance` tiles of land they don't own.
 */
export function isFrontlineNodeTile(
  map: TileGrid,
  smallID: number,
  tile: TileRef,
  borderDistance: number,
): boolean {
  if (!map.isLand(tile) || map.ownerID(tile) !== smallID) return false;
  const x0 = map.x(tile);
  const y0 = map.y(tile);
  for (let dy = -borderDistance; dy <= borderDistance; dy++) {
    for (let dx = -borderDistance; dx <= borderDistance; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (!map.isValidCoord(x, y)) continue;
      const t = map.ref(x, y);
      if (map.isLand(t) && map.ownerID(t) !== smallID) return true;
    }
  }
  return false;
}

/**
 * Tiles to put Frontline nodes on for a drawn line: the line's start, then
 * one every `spacing` tiles along it, and its end when that is at least
 * half a spacing past the last node. The line is walked tile by tile
 * (Bresenham, integer math only, so every client gets the same nodes) and
 * cut off after `maxLength` tiles.
 */
export function frontlineNodeTiles(
  mg: TileGrid,
  path: readonly TileRef[],
  spacing: number,
  maxLength: number,
): TileRef[] {
  const pts = path.filter((t) => mg.isValidRef(t));
  if (pts.length === 0) return [];
  const out: TileRef[] = [pts[0]];
  let walked = 0;
  let sinceNode = 0;
  let last = pts[0];
  for (let i = 1; i < pts.length && walked < maxLength; i++) {
    let x = mg.x(pts[i - 1]);
    let y = mg.y(pts[i - 1]);
    const x1 = mg.x(pts[i]);
    const y1 = mg.y(pts[i]);
    const dx = Math.abs(x1 - x);
    const dy = -Math.abs(y1 - y);
    const sx = x < x1 ? 1 : -1;
    const sy = y < y1 ? 1 : -1;
    let err = dx + dy;
    while ((x !== x1 || y !== y1) && walked < maxLength) {
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
      walked++;
      sinceNode++;
      last = mg.ref(x, y);
      if (sinceNode >= spacing) {
        out.push(last);
        sinceNode = 0;
      }
    }
  }
  if (sinceNode * 2 >= spacing) out.push(last);
  return out;
}
