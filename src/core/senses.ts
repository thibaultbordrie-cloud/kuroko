/**
 * What guards can see and hear. The game and the mission solver call the same functions:
 * a route the solver proves safe is safe in play.
 */
import { DIRS, Grid, T, canStep, type Dir, type Lamp, type Pt } from "./map.js";

export const enum Light {
  Dark = 0,
  Dim = 1,
  Lit = 2,
}

/** How far a guard sees a person standing in light of each level. */
export const SIGHT: readonly number[] = [1.5, 4.5, 7.5];
/** Half-angle of a guard's view cone, in radians (110° in all). */
export const HALF_CONE = (55 * Math.PI) / 180;

/**
 * Is the straight line between two tile centres free of anything opaque?
 * Bresenham both ways: a line counts as clear if either direction is, which keeps sight
 * symmetric (if a guard sees you, you could see them).
 */
export function lineOfSight(a: Pt, b: Pt, see: (x: number, y: number) => boolean): boolean {
  return ray(a, b, see) || ray(b, a, see);
}

function ray(a: Pt, b: Pt, see: (x: number, y: number) => boolean): boolean {
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (x === b.x && y === b.y) return true;
    if (!(x === a.x && y === a.y) && !see(x, y)) return false;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/** A tile lets sight through unless it is opaque; a door is see-through while someone stands in it. */
export function transparency(g: Grid, occupied: ReadonlySet<number>): (x: number, y: number) => boolean {
  return (x, y) => {
    if (!g.opaque(x, y)) return true;
    const t = g.get(x, y);
    return t === T.Door && occupied.has(y * g.w + x);
  };
}

/** Light level of every tile: lamps that are on, with their light stopped by walls. */
export function lightMap(g: Grid, lamps: readonly Lamp[], circuitsOn: ReadonlySet<number>, ambient: Uint8Array): Uint8Array {
  const out = Uint8Array.from(ambient);
  const see = transparency(g, new Set());
  for (const l of lamps) {
    if (!circuitsOn.has(l.circuit)) continue;
    const r = l.radius;
    for (let y = l.at.y - r; y <= l.at.y + r; y++) {
      for (let x = l.at.x - r; x <= l.at.x + r; x++) {
        if (!g.in(x, y)) continue;
        const d = Math.hypot(x - l.at.x, y - l.at.y);
        if (d > r + 0.3) continue;
        if (!lineOfSight(l.at, { x, y }, see)) continue;
        const lvl = d <= r * 0.66 ? Light.Lit : Light.Dim;
        const i = y * g.w + x;
        if ((out[i] as number) < lvl) out[i] = lvl;
      }
    }
  }
  return out;
}

export interface Watcher {
  readonly at: Pt;
  readonly facing: Dir;
  /** Extra sight range (alarm raised: guards look harder). */
  readonly bonus?: number;
}

/**
 * Can this guard see a person on tile p? Inside the cone, within the range the light allows,
 * and with a clear line. A person right next to a guard is always noticed, whatever the cone.
 */
export function sees(g: Grid, w: Watcher, p: Pt, light: Uint8Array, see: (x: number, y: number) => boolean): boolean {
  const dx = p.x - w.at.x;
  const dy = p.y - w.at.y;
  if (dx === 0 && dy === 0) return true;
  const d = Math.hypot(dx, dy);
  const adjacent = Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
  if (!adjacent) {
    const range = (SIGHT[light[p.y * g.w + p.x] as number] as number) + (w.bonus ?? 0);
    if (d > range) return false;
    const f = DIRS[w.facing] as Pt;
    const cos = (dx * f.x + dy * f.y) / (d * Math.hypot(f.x, f.y));
    if (cos < Math.cos(HALF_CONE)) return false;
  }
  return lineOfSight(w.at, p, see);
}

/**
 * The tiles a guard watches, for drawing the cone and for the solver: every walkable tile
 * the guard would notice someone on.
 */
export function watched(g: Grid, w: Watcher, light: Uint8Array, see: (x: number, y: number) => boolean): number[] {
  const out: number[] = [];
  const r = Math.ceil((SIGHT[Light.Lit] as number) + (w.bonus ?? 0));
  for (let y = w.at.y - r; y <= w.at.y + r; y++) {
    for (let x = w.at.x - r; x <= w.at.x + r; x++) {
      // Locked doors too: once picked, someone may stand in them.
      if (!g.in(x, y) || !(g.walkable(x, y) || g.get(x, y) === T.Locked)) continue;
      if (sees(g, w, { x, y }, light, see)) out.push(y * g.w + x);
    }
  }
  return out;
}

/**
 * How far a sound carries, as walking distance: walls stop it, doors muffle it (a door
 * costs three steps of the sound's range). Returns the distance to every tile it reaches.
 */
export function hearing(g: Grid, from: Pt, loudness: number): Map<number, number> {
  const out = new Map<number, number>();
  const start = from.y * g.w + from.x;
  out.set(start, 0);
  const queue: [number, number][] = [[start, 0]];
  while (queue.length > 0) {
    queue.sort((a, b) => a[1] - b[1]);
    const [i, d] = queue.shift() as [number, number];
    if (d > (out.get(i) ?? Infinity)) continue;
    const x = i % g.w;
    const y = (i - x) / g.w;
    for (let k = 0; k < 8; k += 2) {
      const n = DIRS[k] as Pt;
      const nx = x + n.x;
      const ny = y + n.y;
      const t = g.get(nx, ny);
      if (t === T.Wall || t === T.Void || t === T.Window) continue;
      const cost = t === T.Door || t === T.Locked || t === T.Hide ? 3 : 1;
      const nd = d + cost;
      if (nd > loudness) continue;
      const ni = ny * g.w + nx;
      if (nd < (out.get(ni) ?? Infinity)) {
        out.set(ni, nd);
        queue.push([ni, nd]);
      }
    }
  }
  return out;
}

/** Shortest walking path (A*, eight directions, no corner cutting). Includes start and goal. */
export function path(g: Grid, from: Pt, to: Pt, blocked?: (x: number, y: number) => boolean): Pt[] | null {
  if (from.x === to.x && from.y === to.y) return [from];
  const W = g.w;
  const goal = to.y * W + to.x;
  const startI = from.y * W + from.x;
  const gScore = new Map<number, number>([[startI, 0]]);
  const came = new Map<number, number>();
  const h = (i: number) => {
    const x = i % W;
    const y = (i - x) / W;
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + 0.41 * Math.min(dx, dy);
  };
  const open: [number, number][] = [[startI, h(startI)]];
  const closed = new Set<number>();
  while (open.length > 0) {
    let best = 0;
    for (let k = 1; k < open.length; k++) if ((open[k] as [number, number])[1] < (open[best] as [number, number])[1]) best = k;
    const [cur] = open.splice(best, 1)[0] as [number, number];
    if (cur === goal) {
      const out: Pt[] = [];
      let c: number | undefined = cur;
      while (c !== undefined) {
        const x = c % W;
        out.push({ x, y: (c - x) / W });
        c = came.get(c);
      }
      return out.reverse();
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (const d of DIRS) {
      const nx = cx + d.x;
      const ny = cy + d.y;
      const ni = ny * W + nx;
      if (closed.has(ni)) continue;
      if (!canStep(g, { x: cx, y: cy }, { x: nx, y: ny })) continue;
      if (blocked && ni !== goal && blocked(nx, ny)) continue;
      const cost = (gScore.get(cur) as number) + (d.x !== 0 && d.y !== 0 ? 1.41 : 1);
      if (cost < (gScore.get(ni) ?? Infinity)) {
        gScore.set(ni, cost);
        came.set(ni, cur);
        open.push([ni, cost + h(ni)]);
      }
    }
  }
  return null;
}
