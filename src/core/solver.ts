/**
 * Proves a mission can be done without being seen. While no one is alerted, guards follow
 * their rounds exactly, so their position at every turn is known: the solver searches
 * (tile, turn, progress) for a route on which no guard ever sees the agent, using the same
 * sight rules as the game. It plans for the slowest lock (worst roll), so the proof holds
 * whatever the dice say.
 */
import { DIRS, T, type Pt } from "./map.js";
import { hearing, lightMap, path, transparency, watched } from "./senses.js";
import type { MissionDef } from "./types.js";

export const HORIZON = 360;
/** Turns to pick the archive lock at worst; to photograph the document. */
export const PICK_WORST = 5;
export const PHOTO_TURNS = 2;

type Draft = Omit<MissionDef, "ghost">;

/** Which tiles some guard watches at each turn, if nobody disturbs the rounds. */
export function timeline(m: Draft, horizon = HORIZON): { seen: Uint8Array[]; heard: Uint8Array[] } {
  const g = m.grid;
  const light = lightMap(g, m.lamps, new Set(m.panels.map((p) => p.circuit)), m.ambient);
  const seen: Uint8Array[] = [];
  const heard: Uint8Array[] = [];
  for (let t = 0; t <= horizon + 1; t++) {
    const s = new Uint8Array(g.w * g.h);
    const h = new Uint8Array(g.w * g.h);
    const occupied = new Set<number>();
    for (const gd of m.guards) {
      const st = gd.route[t % gd.route.length];
      if (st) occupied.add(st.at.y * g.w + st.at.x);
    }
    const see = transparency(g, occupied);
    for (const gd of m.guards) {
      const st = gd.route[t % gd.route.length];
      if (!st) continue;
      for (const i of watched(g, { at: st.at, facing: st.facing }, light, see)) s[i] = 1;
      // A sound of loudness 1 next to a guard is heard: mark the tiles a quiet noise would carry from.
      for (const [i] of hearing(g, st.at, 1)) h[i] = 1;
    }
    seen.push(s);
    heard.push(h);
  }
  return { seen, heard };
}

/**
 * The ghost route, or null. Progress: 0 the archive is locked, 1 it is open, 2 the document is
 * photographed. Each move is checked twice: before the guards step, and after.
 */
export function solve(m: Draft): Pt[] | null {
  const g = m.grid;
  const N = g.w * g.h;
  const { seen, heard } = timeline(m);
  const doc = m.items.find((i) => i.kind === "document");
  if (!doc) return null;
  const locked: Pt[] = [];
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.get(x, y) === T.Locked) locked.push({ x, y });
  const exitSet = new Set(m.exits.map((e) => e.y * g.w + e.x));

  const idx = (p: number, t: number, k: number) => (k * (HORIZON + 1) + t) * N + p;
  const total = 3 * (HORIZON + 1) * N;
  const parent = new Int32Array(total).fill(-1);
  const visited = new Uint8Array(total);
  const start = idx(m.entry.y * g.w + m.entry.x, 0, 0);
  visited[start] = 1;
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;

  const clear = (p: number, t0: number, t1: number, quiet: boolean) => {
    for (let t = t0; t <= t1; t++) {
      if (t > HORIZON + 1) return false;
      if ((seen[t] as Uint8Array)[p]) return false;
      if (quiet && (heard[t] as Uint8Array)[p]) return false;
    }
    return true;
  };
  const passable = (x: number, y: number, k: number) => g.walkable(x, y) || (k >= 1 && g.get(x, y) === T.Locked);
  const stepOk = (from: Pt, to: Pt, k: number) => {
    if (!passable(to.x, to.y, k)) return false;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx !== 0 && dy !== 0) return passable(from.x + dx, from.y, k) && passable(from.x, from.y + dy, k);
    return true;
  };
  const push = (from: number, to: number) => {
    if (visited[to]) return;
    visited[to] = 1;
    parent[to] = from;
    queue[tail++] = to;
  };

  while (head < tail) {
    const s = queue[head++] as number;
    const p = s % N;
    const rest = (s - p) / N;
    const t = rest % (HORIZON + 1);
    const k = (rest - t) / (HORIZON + 1);
    const x = p % g.w;
    const y = (p - x) / g.w;
    if (k === 2 && exitSet.has(p)) return unwind(parent, s, N, g.w);
    if (t >= HORIZON) continue;
    // Wait.
    if (clear(p, t + 1, t + 1, false)) push(s, idx(p, t + 1, k));
    // Walk, quietly.
    for (const d of DIRS) {
      const q = { x: x + d.x, y: y + d.y };
      if (!g.in(q.x, q.y) || !stepOk({ x, y }, q, k)) continue;
      const qi = q.y * g.w + q.x;
      if (clear(qi, t, t + 1, false)) push(s, idx(qi, t + 1, k));
    }
    // Pick the lock, from a tile next to it, at worst speed, unseen and unheard.
    if (k === 0 && locked.some((l) => Math.abs(l.x - x) + Math.abs(l.y - y) === 1) && t + PICK_WORST <= HORIZON) {
      if (clear(p, t, t + PICK_WORST, true)) push(s, idx(p, t + PICK_WORST, 1));
    }
    // Photograph the document from next to its desk.
    if (k === 1 && Math.max(Math.abs(doc.at.x - x), Math.abs(doc.at.y - y)) === 1 && t + PHOTO_TURNS <= HORIZON) {
      if (clear(p, t, t + PHOTO_TURNS, false)) push(s, idx(p, t + PHOTO_TURNS, 2));
    }
  }
  return null;
}

/** The route turn by turn: index i is where the agent stands at turn i (picking and photographing repeat the tile). */
function unwind(parent: Int32Array, end: number, N: number, w: number): Pt[] {
  const states: { p: number; t: number }[] = [];
  let s = end;
  while (s >= 0) {
    const p = s % N;
    const t = ((s - p) / N) % (HORIZON + 1);
    states.push({ p, t });
    s = parent[s] as number;
  }
  states.reverse();
  const out: Pt[] = [];
  for (const st of states) {
    while (out.length <= st.t) out.push({ x: st.p % w, y: Math.floor(st.p / w) });
  }
  return out;
}

/**
 * Would someone walking the shortest way, at sneaking pace, without watching the guards,
 * be seen? A mission where they would not is too easy to keep.
 */
export function naiveIsSeen(m: Draft): boolean {
  const g = m.grid;
  const { seen } = timeline(m);
  const doc = m.items.find((i) => i.kind === "document");
  const lock = (() => {
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.get(x, y) === T.Locked) return { x, y };
    return null;
  })();
  if (!doc || !lock) return true;
  const open = g.clone();
  open.set(lock.x, lock.y, T.Door);
  const near = (target: Pt, from: Pt) => {
    let best: Pt[] | null = null;
    for (const d of DIRS) {
      const q = { x: target.x + d.x, y: target.y + d.y };
      if (!open.walkable(q.x, q.y)) continue;
      const p = path(open, from, q);
      if (p && (!best || p.length < best.length)) best = p;
    }
    return best;
  };
  const a = path(g, m.entry, nextTo(g, lock) ?? m.entry);
  const b = a ? near(doc.at, a[a.length - 1] as Pt) : null;
  const c = b ? path(open, b[b.length - 1] as Pt, m.entry) : null;
  if (!a || !b || !c) return true;
  const walk: Pt[] = [...a];
  for (let i = 0; i < PICK_WORST; i++) walk.push(a[a.length - 1] as Pt);
  walk.push(...b.slice(1));
  for (let i = 0; i < PHOTO_TURNS; i++) walk.push(b[b.length - 1] as Pt);
  walk.push(...c.slice(1));
  for (let t = 0; t < walk.length && t <= HORIZON; t++) {
    const p = walk[t] as Pt;
    if ((seen[t] as Uint8Array)[p.y * g.w + p.x]) return true;
  }
  return false;
}

function nextTo(g: MissionDef["grid"], p: Pt): Pt | null {
  for (let k = 0; k < 8; k += 2) {
    const d = DIRS[k] as Pt;
    const q = { x: p.x + d.x, y: p.y + d.y };
    if (g.walkable(q.x, q.y) && g.room(q.x, q.y) === 0) return q;
  }
  for (let k = 0; k < 8; k += 2) {
    const d = DIRS[k] as Pt;
    const q = { x: p.x + d.x, y: p.y + d.y };
    if (g.walkable(q.x, q.y)) return q;
  }
  return null;
}

