/** The grid a mission is played on. Pure data: no drawing, no randomness. */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Eight directions, clockwise from north. */
export const DIRS: readonly Pt[] = [
  { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];

export function dirTo(from: Pt, to: Pt): Dir {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  // atan2 0 = east = dir 2; each step is 45°.
  const step = Math.round(a / (Math.PI / 4));
  return (((step + 2) % 8) + 8) % 8 as Dir;
}

export const eq = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;
export const cheb = (a: Pt, b: Pt) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export const enum T {
  Void = 0,
  Wall = 1,
  Floor = 2,
  Door = 3,
  /** A door that needs a key or a lockpick. */
  Locked = 4,
  /** Desks, crates: block movement, not sight. */
  Furniture = 5,
  /** Shelves, partitions: block movement and sight. */
  Tall = 6,
  /** A cupboard or curtain: walk in to hide. */
  Hide = 7,
  /** Where the agent enters and leaves. */
  Exit = 8,
  Window = 9,
}

export type RoomKind = "lobby" | "corridor" | "office" | "archive" | "security" | "storage" | "lounge";

export interface Room {
  readonly id: number;
  readonly kind: RoomKind;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Lamp {
  readonly at: Pt;
  readonly radius: number;
  /** Which switch panel turns it off. */
  readonly circuit: number;
}

export interface Panel {
  readonly at: Pt;
  readonly circuit: number;
}

export class Grid {
  readonly tiles: Uint8Array;
  /** Room id of each floor tile, -1 elsewhere. */
  readonly roomOf: Int16Array;

  constructor(readonly w: number, readonly h: number) {
    this.tiles = new Uint8Array(w * h);
    this.roomOf = new Int16Array(w * h).fill(-1);
  }

  in(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(x: number, y: number): T {
    return this.in(x, y) ? (this.tiles[y * this.w + x] as T) : T.Void;
  }

  set(x: number, y: number, t: T): void {
    if (this.in(x, y)) this.tiles[y * this.w + x] = t;
  }

  room(x: number, y: number): number {
    return this.in(x, y) ? (this.roomOf[y * this.w + x] as number) : -1;
  }

  /** Can someone stand here? Locked doors only once open. */
  walkable(x: number, y: number): boolean {
    const t = this.get(x, y);
    return t === T.Floor || t === T.Door || t === T.Hide || t === T.Exit;
  }

  /** Does this tile stop a line of sight? Doors do unless someone stands in them. */
  opaque(x: number, y: number): boolean {
    const t = this.get(x, y);
    return t === T.Wall || t === T.Tall || t === T.Door || t === T.Locked || t === T.Void || t === T.Hide;
  }

  clone(): Grid {
    const g = new Grid(this.w, this.h);
    g.tiles.set(this.tiles);
    g.roomOf.set(this.roomOf);
    return g;
  }
}

/**
 * Moving diagonally is allowed only when both side tiles are free: no slipping between
 * two walls, and a guard's view and a player's path follow the same rule.
 */
export function canStep(g: Grid, from: Pt, to: Pt): boolean {
  if (!g.walkable(to.x, to.y)) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  if (dx !== 0 && dy !== 0) return g.walkable(from.x + dx, from.y) && g.walkable(from.x, from.y + dy);
  return true;
}
