/**
 * Builds a mission: a building with a corridor, rooms on both sides, an archive behind a
 * locked door, lights on circuits, and guards on their rounds. A mission is kept only if the
 * solver proves it can be done without being seen, and if walking straight in would not be.
 */
import { DIRS, Grid, T, dirTo, type Dir, type Lamp, type Panel, type Pt, type Room, type RoomKind } from "./map.js";
import { Rng } from "./rng.js";
import { path } from "./senses.js";
import { solve, naiveIsSeen } from "./solver.js";
import type { GuardDef, Item, MissionDef, RouteStep, Site } from "./types.js";

export const W = 38;
export const H = 23;

export interface GenOptions {
  readonly seed: string;
  readonly site: Site;
  /** 1 to 3: more guards, tighter rounds, harder lock. */
  readonly level: number;
  readonly names: (rng: Rng) => string;
}

/** Tries successive sub-seeds until a building passes both checks. */
export function generate(opts: GenOptions): MissionDef {
  for (let attempt = 0; attempt < 400; attempt++) {
    const rng = new Rng(`${opts.seed}#${attempt}`);
    const m = build(rng, opts);
    if (!m) continue;
    const ghost = solve(m);
    if (!ghost) continue;
    if (!naiveIsSeen(m)) continue;
    return { ...m, ghost };
  }
  throw new Error(`no mission found for seed ${opts.seed}`);
}

type Draft = Omit<MissionDef, "ghost">;

interface RoomDraft extends Room {
  doors: Pt[];
  /** Rooms reached only through another room. */
  inner: boolean;
  touchesCorridor: boolean;
}

function build(rng: Rng, opts: GenOptions): Draft | null {
  const g = new Grid(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.set(x, y, T.Wall);

  // The corridor: two tiles high across the building, sometimes with a branch.
  const cy = rng.int(9, 12);
  const corridor: Room = { id: 0, kind: "corridor", x: 1, y: cy, w: W - 2, h: 2 };
  carve(g, corridor);
  const rooms: RoomDraft[] = [{ ...corridor, doors: [], inner: false, touchesCorridor: false }];

  const bands = [
    { y0: 1, y1: cy - 2, side: -1 },
    { y0: cy + 3, y1: H - 2, side: 1 },
  ];
  for (const band of bands) {
    let x = 1;
    while (x < W - 1) {
      const left = W - 1 - x;
      let w = rng.int(5, 9);
      if (left - w < 5) w = left;
      if (w < 4) break;
      const h = band.y1 - band.y0 + 1;
      // Deep bands sometimes hold two rooms, the far one reached through the near one.
      if (h >= 8 && rng.chance(0.45)) {
        const split = rng.int(3, h - 4);
        const nearTop = band.side === 1;
        const a = nearTop ? { y: band.y0, h: split } : { y: band.y1 - split + 1, h: split };
        const b = nearTop ? { y: band.y0 + split + 1, h: h - split - 1 } : { y: band.y0, h: h - split - 1 };
        rooms.push(room(g, rooms.length, x, a.y, w, a.h, false));
        rooms.push(room(g, rooms.length, x, b.y, w, b.h, true));
      } else {
        rooms.push(room(g, rooms.length, x, band.y0, w, h, false));
      }
      x += w + 1;
    }
  }
  const all = rooms.slice(1);
  if (all.length < 6) return null;

  // Doors: every outer room opens on the corridor; inner rooms open on their outer room.
  for (const r of all) {
    if (!r.inner) {
      const wy = r.y > cy ? r.y - 1 : r.y + r.h;
      r.touchesCorridor = true;
      const dx = rng.int(r.x + 1, r.x + r.w - 2);
      g.set(dx, wy, T.Door);
      r.doors.push({ x: dx, y: wy });
    } else {
      const outer = all.find((o) => !o.inner && o.x === r.x);
      if (!outer) return null;
      const wy = r.y < outer.y ? r.y + r.h : r.y - 1;
      const dx = rng.int(r.x + 1, r.x + r.w - 2);
      g.set(dx, wy, T.Door);
      r.doors.push({ x: dx, y: wy });
      outer.doors.push({ x: dx, y: wy });
    }
  }
  // Some neighbours share a door: loops make rounds harder to read and give the player choices.
  for (const a of all) {
    for (const b of all) {
      if (a.id >= b.id || a.inner !== b.inner) continue;
      if (a.x + a.w + 1 !== b.x) continue;
      const y0 = Math.max(a.y, b.y) + 1;
      const y1 = Math.min(a.y + a.h, b.y + b.h) - 2;
      if (y1 < y0 || !rng.chance(0.35)) continue;
      const dy = rng.int(y0, y1);
      g.set(a.x + a.w, dy, T.Door);
      a.doors.push({ x: a.x + a.w, y: dy });
      b.doors.push({ x: a.x + a.w, y: dy });
    }
  }

  // Ways in and out: a service door at one end of the corridor; the main entrance at the other.
  const west = rng.chance(0.5);
  const entry: Pt = { x: west ? 0 : W - 1, y: cy + rng.int(0, 1) };
  g.set(entry.x, entry.y, T.Exit);
  const exits: Pt[] = [entry];
  // A window out of a far room, sometimes.
  const windowRoom = rng.pick(all.filter((r) => r.y === 1 || r.y + r.h === H - 1));
  if (rng.chance(0.6)) {
    const wy = windowRoom.y === 1 ? 0 : H - 1;
    const wx = rng.int(windowRoom.x + 1, windowRoom.x + windowRoom.w - 2);
    g.set(wx, wy, T.Exit);
    exits.push({ x: wx, y: wy });
  }

  // Room kinds. The archive is the room farthest from the way in; inner rooms first.
  const far = (r: Room) => Math.abs(r.x + r.w / 2 - entry.x);
  const ranked = all.slice().sort((a, b) => far(b) - far(a) + (b.inner ? 3 : 0) - (a.inner ? 3 : 0));
  const archive = ranked.find((r) => r.doors.length === 1 && r.id !== windowRoom.id) ?? ranked[0];
  if (!archive) return null;
  const kinds = new Map<number, RoomKind>([[archive.id, "archive"]]);
  const byNear = all.filter((r) => !kinds.has(r.id)).sort((a, b) => far(a) - far(b));
  const lobbyEnd = byNear[byNear.length - 1];
  const security = byNear.find((r) => r.touchesCorridor && r.id !== lobbyEnd?.id && far(r) > W / 3);
  if (!security || !lobbyEnd) return null;
  kinds.set(lobbyEnd.id, "lobby");
  kinds.set(security.id, "security");
  for (const r of all) {
    if (kinds.has(r.id)) continue;
    kinds.set(r.id, r.w * r.h < 30 ? "storage" : rng.pick<RoomKind>(["office", "office", "storage", "lounge"]));
  }
  const finalRooms: Room[] = rooms.map((r) => ({ id: r.id, kind: r.id === 0 ? "corridor" : (kinds.get(r.id) as RoomKind), x: r.x, y: r.y, w: r.w, h: r.h }));

  // The archive's doors are locked.
  for (const d of archive.doors) g.set(d.x, d.y, T.Locked);

  // Furniture, cupboards to hide in, and the objects.
  const items: Item[] = [];
  const doorsNear = (r: RoomDraft) => r.doors;
  for (const r of all) furnish(g, rng, r, kinds.get(r.id) as RoomKind, doorsNear(r), items);
  if (!items.some((i) => i.kind === "document") || !items.some((i) => i.kind === "key")) return null;

  // Lights. Three circuits, by thirds of the building; a switch panel for each on the corridor wall.
  const circuitOf = (x: number) => Math.min(2, Math.floor((x / W) * 3));
  const lamps: Lamp[] = [];
  for (const r of finalRooms) {
    const c = { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
    const radius = Math.ceil(Math.max(r.w, r.h) / 2) + 1;
    if (r.kind === "corridor") {
      for (let x = 4; x < W - 3; x += rng.int(7, 10)) lamps.push({ at: { x, y: cy }, radius: 3, circuit: circuitOf(x) });
    } else if (r.kind === "office" || r.kind === "lobby" || r.kind === "security" || r.kind === "lounge") {
      lamps.push({ at: c, radius, circuit: circuitOf(c.x) });
    } else if (r.kind === "archive") {
      lamps.push({ at: c, radius: 2, circuit: circuitOf(c.x) });
    }
  }
  const panels: Panel[] = [];
  for (let c = 0; c < 3; c++) {
    const xs: number[] = [];
    for (let x = Math.ceil((c * W) / 3) + 1; x < Math.floor(((c + 1) * W) / 3) - 1; x++) {
      if (g.get(x, cy - 1) === T.Wall && g.get(x, cy) === T.Floor) xs.push(x);
    }
    if (xs.length === 0) return null;
    const px = rng.pick(xs);
    panels.push({ at: { x: px, y: cy - 1 }, circuit: c });
    items.push({ kind: "panel", at: { x: px, y: cy - 1 }, circuit: c });
  }
  const ambient = new Uint8Array(W * H);
  for (let x = 1; x < W - 1; x++) {
    ambient[cy * W + x] = 1;
    ambient[(cy + 1) * W + x] = 1;
  }
  for (const e of exits) {
    for (const d of DIRS) {
      const x = e.x + d.x;
      const y = e.y + d.y;
      if (g.in(x, y)) ambient[y * W + x] = 1;
    }
  }

  // Guards.
  const guards: GuardDef[] = [];
  const lobby = finalRooms.find((r) => r.kind === "lobby") as Room;
  const sec = finalRooms.find((r) => r.kind === "security") as Room;
  guards.push(post(g, rng, guards.length, opts.names(rng), lobby, cy));
  guards.push(post(g, rng, guards.length, opts.names(rng), sec, cy));
  // The corridor walker.
  const cw = corridorRound(g, rng, cy, entry);
  if (!cw) return null;
  guards.push({ id: guards.length, name: opts.names(rng), route: cw, post: false });
  const extra = opts.level;
  const candidates = rng.shuffle(all.filter((r) => kinds.get(r.id) !== "archive" && kinds.get(r.id) !== "lobby"));
  for (let k = 0; k < extra; k++) {
    const stops = candidates.slice(k * 2, k * 2 + 2 + (opts.level > 2 ? 1 : 0));
    if (stops.length < 2) break;
    const route = roomsRound(g, rng, stops, cy);
    if (!route) return null;
    guards.push({ id: guards.length, name: opts.names(rng), route: phase(route, rng), post: false });
  }

  return {
    seed: opts.seed, site: opts.site, level: opts.level, grid: g, rooms: finalRooms, lamps, panels, ambient,
    entry, exits, items, guards, lock: 7 + opts.level,
  };
}

function carve(g: Grid, r: Room): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      g.set(x, y, T.Floor);
      g.roomOf[y * g.w + x] = r.id;
    }
  }
}

function room(g: Grid, id: number, x: number, y: number, w: number, h: number, inner: boolean): RoomDraft {
  const r: RoomDraft = { id, kind: "office", x, y, w, h, doors: [], inner, touchesCorridor: false };
  carve(g, r);
  return r;
}

/** Tiles in front of each door must stay free, and the room must stay in one piece. */
function furnish(g: Grid, rng: Rng, r: RoomDraft, kind: RoomKind, doors: readonly Pt[], items: Item[]): void {
  const keep = new Set<number>();
  for (const d of doors) {
    for (const n of DIRS) keep.add((d.y + n.y) * g.w + d.x + n.x);
  }
  const place = (x: number, y: number, t: T): boolean => {
    if (x <= r.x - 1 || y <= r.y - 1 || x >= r.x + r.w || y >= r.y + r.h) return false;
    const i = y * g.w + x;
    if (keep.has(i) || g.get(x, y) !== T.Floor) return false;
    g.set(x, y, t);
    if (!connected(g, r, doors)) {
      g.set(x, y, T.Floor);
      return false;
    }
    return true;
  };
  const inside = (): Pt => ({ x: rng.int(r.x, r.x + r.w - 1), y: rng.int(r.y, r.y + r.h - 1) });
  const alongWall = (): Pt => {
    const side = rng.int(0, 3);
    if (side === 0) return { x: rng.int(r.x, r.x + r.w - 1), y: r.y };
    if (side === 1) return { x: rng.int(r.x, r.x + r.w - 1), y: r.y + r.h - 1 };
    if (side === 2) return { x: r.x, y: rng.int(r.y, r.y + r.h - 1) };
    return { x: r.x + r.w - 1, y: rng.int(r.y, r.y + r.h - 1) };
  };
  const tries = (n: number, f: () => boolean) => {
    for (let i = 0; i < n * 6 && n > 0; i++) if (f()) n--;
  };

  switch (kind) {
    case "archive": {
      // Rows of shelves, the document on a desk among them.
      for (let x = r.x + 1; x < r.x + r.w - 1; x += 2) {
        for (let y = r.y + 1; y < r.y + r.h - 1; y++) if (rng.chance(0.75)) place(x, y, T.Tall);
      }
      let placed = false;
      for (let i = 0; i < 40 && !placed; i++) {
        const p = inside();
        if (place(p.x, p.y, T.Furniture)) {
          items.push({ kind: "document", at: p });
          placed = true;
        }
      }
      tries(1, () => {
        const p = alongWall();
        return place(p.x, p.y, T.Hide);
      });
      break;
    }
    case "security": {
      let placed = false;
      for (let i = 0; i < 40 && !placed; i++) {
        const p = alongWall();
        if (place(p.x, p.y, T.Furniture)) {
          items.push({ kind: "key", at: p });
          placed = true;
        }
      }
      tries(2, () => {
        const p = alongWall();
        return place(p.x, p.y, T.Furniture);
      });
      break;
    }
    case "office": {
      for (let y = r.y + 1; y < r.y + r.h - 1; y += 2) {
        for (let x = r.x + 1; x < r.x + r.w - 1; x++) if (rng.chance(0.55)) place(x, y, T.Furniture);
      }
      tries(rng.int(1, 2), () => {
        const p = alongWall();
        return place(p.x, p.y, T.Hide);
      });
      break;
    }
    case "storage": {
      tries(Math.floor((r.w * r.h) / 5), () => {
        const p = inside();
        return place(p.x, p.y, rng.chance(0.3) ? T.Tall : T.Furniture);
      });
      tries(2, () => {
        const p = alongWall();
        return place(p.x, p.y, T.Hide);
      });
      break;
    }
    case "lounge": {
      tries(3, () => {
        const p = inside();
        return place(p.x, p.y, T.Furniture);
      });
      tries(1, () => {
        const p = alongWall();
        return place(p.x, p.y, T.Hide);
      });
      break;
    }
    case "lobby": {
      tries(2, () => {
        const p = inside();
        return place(p.x, p.y, T.Furniture);
      });
      break;
    }
    case "corridor":
      break;
  }
}

/** Every walkable tile of the room reachable from its first door, and every door reached. */
function connected(g: Grid, r: Room, doors: readonly Pt[]): boolean {
  const first = doors[0];
  if (!first) return true;
  const seen = new Set<number>([first.y * g.w + first.x]);
  const stack: Pt[] = [first];
  while (stack.length > 0) {
    const p = stack.pop() as Pt;
    for (let k = 0; k < 8; k += 2) {
      const d = DIRS[k] as Pt;
      const q = { x: p.x + d.x, y: p.y + d.y };
      const i = q.y * g.w + q.x;
      if (seen.has(i)) continue;
      const inRoom = q.x >= r.x && q.y >= r.y && q.x < r.x + r.w && q.y < r.y + r.h;
      const isDoor = doors.some((dd) => dd.x === q.x && dd.y === q.y);
      if (!inRoom && !isDoor) continue;
      const t = g.get(q.x, q.y);
      if (t === T.Furniture || t === T.Tall || t === T.Wall) continue;
      seen.add(i);
      stack.push(q);
    }
  }
  for (const d of doors) if (!seen.has(d.y * g.w + d.x)) return false;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const t = g.get(x, y);
      if ((t === T.Floor || t === T.Hide) && !seen.has(y * g.w + x)) return false;
      // Every desk must be usable from a free tile next to it.
      if (t === T.Furniture && !DIRS.some((d) => seen.has((y + d.y) * g.w + x + d.x))) return false;
    }
  }
  return true;
}

/** A guard at a post: stands still and turns their head, a few turns each way. */
function post(g: Grid, rng: Rng, id: number, name: string, r: Room, cy: number): GuardDef {
  let spot: Pt = { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
  for (let i = 0; i < 30 && !g.walkable(spot.x, spot.y); i++) spot = { x: rng.int(r.x, r.x + r.w - 1), y: rng.int(r.y, r.y + r.h - 1) };
  const towardCorridor: Dir = r.y < cy ? 4 : 0;
  const look: Dir[] = [towardCorridor, ((towardCorridor + 1) % 8) as Dir, towardCorridor, ((towardCorridor + 7) % 8) as Dir];
  const steps: RouteStep[] = [];
  for (const f of look) for (let k = 0; k < 3; k++) steps.push({ at: spot, facing: f });
  return { id, name, route: phase(steps, rng), post: true };
}

/** Walks the corridor from end to end and back, pausing at each end. */
function corridorRound(g: Grid, rng: Rng, cy: number, entry: Pt): RouteStep[] | null {
  const lane = cy + rng.int(0, 1);
  const a: Pt = { x: entry.x === 0 ? 3 : W - 4, y: lane };
  const b: Pt = { x: entry.x === 0 ? W - 3 : 2, y: lane };
  const route = roundThrough(g, [b, a], 3);
  return route ? phase(route, rng) : null;
}

function roomsRound(g: Grid, rng: Rng, rooms: readonly Room[], cy: number): RouteStep[] | null {
  const stops: Pt[] = [];
  for (const r of rooms) {
    let p: Pt | null = null;
    for (let i = 0; i < 30 && !p; i++) {
      const q = { x: rng.int(r.x, r.x + r.w - 1), y: rng.int(r.y, r.y + r.h - 1) };
      if (g.walkable(q.x, q.y) && g.get(q.x, q.y) !== T.Hide) p = q;
    }
    if (!p) return null;
    stops.push(p);
    stops.push({ x: Math.min(W - 2, Math.max(1, p.x)), y: cy + rng.int(0, 1) });
  }
  return roundThrough(g, stops, 2);
}

/** A closed loop through the stops, pausing and looking left and right at each. */
function roundThrough(g: Grid, stops: readonly Pt[], pause: number): RouteStep[] | null {
  const steps: RouteStep[] = [];
  for (let i = 0; i < stops.length; i++) {
    const from = stops[i] as Pt;
    const to = stops[(i + 1) % stops.length] as Pt;
    const p = path(g, from, to, (x, y) => g.get(x, y) === T.Hide);
    if (!p) return null;
    for (let k = 0; k < p.length - 1; k++) {
      const here = p[k] as Pt;
      steps.push({ at: here, facing: dirTo(here, p[k + 1] as Pt) });
    }
    const last = steps[steps.length - 1];
    const f = last ? last.facing : 0;
    for (let k = 0; k < pause; k++) steps.push({ at: to, facing: (((f + (k % 2 === 0 ? 2 : 6)) % 8) as Dir) });
  }
  return steps.length > 0 ? steps : null;
}

/** Starts a round at a random point, so two guards on similar loops are not in step. */
function phase(route: RouteStep[], rng: Rng): RouteStep[] {
  const k = rng.int(0, route.length - 1);
  return route.slice(k).concat(route.slice(0, k));
}
