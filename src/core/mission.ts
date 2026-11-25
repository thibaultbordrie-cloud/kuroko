/**
 * Playing a mission, turn by turn. The agent acts, then every guard acts and looks around.
 * Everything follows from the mission's seed and the agent's actions: a mission can be
 * replayed exactly from its action log, which is also how a game is saved.
 */
import { chance, roll, type Roll } from "./dice.js";
import { DIRS, T, canStep, cheb, dirTo, eq, type Dir, type Grid, type Pt } from "./map.js";
import { Rng } from "./rng.js";
import { hearing, lightMap, lineOfSight, path, sees, transparency, watched, Light, SIGHT } from "./senses.js";
import type { Item, MissionDef } from "./types.js";

export interface Agent {
  readonly codename: string;
  /** 1 to 4. Moving unseen. */
  readonly discretion: number;
  /** 1 to 4. Keeping a cover story straight under pressure. */
  readonly nerve: number;
  /** 1 to 4. Locks and cameras. */
  readonly technique: number;
}

export type Mode = "patrol" | "notice" | "investigate" | "look" | "search" | "return" | "alert" | "fix";

export interface GuardState {
  readonly id: number;
  readonly name: string;
  at: Pt;
  facing: Dir;
  mode: Mode;
  /** 0 to 100: at 100 the guard is sure. */
  suspicion: number;
  routeIdx: number;
  target: Pt | null;
  timer: number;
  searchLeft: number;
  lastSeen: Pt | null;
  hurry: boolean;
  /** Did this guard see the agent at the last look? */
  sight: boolean;
}

export type Action =
  | { readonly t: "step"; readonly d: Dir }
  | { readonly t: "run"; readonly d: Dir }
  | { readonly t: "wait" }
  | { readonly t: "pick" }
  | { readonly t: "use" }
  | { readonly t: "throw"; readonly at: Pt }
  | { readonly t: "leave" }
  | { readonly t: "bluff" }
  | { readonly t: "flee" };

export type Event =
  | { readonly k: "noise"; readonly at: Pt; readonly loud: number }
  | { readonly k: "notice"; readonly guard: number }
  | { readonly k: "spotted"; readonly guard: number }
  | { readonly k: "radio"; readonly guard: number }
  | { readonly k: "found"; readonly guard: number }
  | { readonly k: "dice"; readonly what: "pick" | "bluff"; readonly roll: Roll }
  | { readonly k: "unlock"; readonly at: Pt }
  | { readonly k: "key" }
  | { readonly k: "photo" }
  | { readonly k: "lights"; readonly circuit: number; readonly on: boolean }
  | { readonly k: "confront"; readonly guard: number }
  | { readonly k: "end"; readonly outcome: Outcome };

export type Status = "play" | "confront" | "done";
export type Outcome = "ghost" | "quiet" | "loud" | "burned" | "captured" | "aborted" | "dawn";

export const DAWN = 420;
export const COINS = 3;

export class Mission {
  readonly def: MissionDef;
  readonly agent: Agent;
  readonly grid: Grid;
  turn = 0;
  status: Status = "play";
  outcome: Outcome | null = null;
  player: { at: Pt; facing: Dir; coins: number; key: boolean; photo: boolean; pickLeft: number; picked: boolean };
  readonly guards: GuardState[];
  readonly circuitsOn: Set<number>;
  alarm = 0;
  confronting: number | null = null;
  /** The highest suspicion any guard reached; whether the agent was ever spotted. */
  peak = 0;
  spotted = false;
  bluffed = false;
  readonly log: Action[] = [];
  events: Event[] = [];
  light: Uint8Array;
  private dice: Rng;
  private ai: Rng;
  private noises: { at: Pt; loud: number }[] = [];
  private fixLater: { circuit: number; in: number } | null = null;

  constructor(def: MissionDef, agent: Agent) {
    this.def = def;
    this.agent = agent;
    this.grid = def.grid.clone();
    const root = new Rng(`${def.seed}/play`);
    this.dice = root.fork("dice");
    this.ai = root.fork("ai");
    this.player = { at: def.entry, facing: dirTo(def.entry, { x: def.grid.w / 2, y: def.entry.y }), coins: COINS, key: false, photo: false, pickLeft: 0, picked: false };
    this.guards = def.guards.map((gd) => {
      const s = gd.route[0];
      if (!s) throw new Error("guard without a round");
      return {
        id: gd.id, name: gd.name, at: s.at, facing: s.facing, mode: "patrol", suspicion: 0, routeIdx: 0,
        target: null, timer: 0, searchLeft: 0, lastSeen: null, hurry: false, sight: false,
      };
    });
    this.circuitsOn = new Set(def.panels.map((p) => p.circuit));
    this.light = this.computeLight();
  }

  /** Replays a saved action log on a fresh mission. */
  static replay(def: MissionDef, agent: Agent, log: readonly Action[]): Mission {
    const m = new Mission(def, agent);
    for (const a of log) m.act(a);
    return m;
  }

  private computeLight(): Uint8Array {
    return lightMap(this.grid, this.def.lamps, this.circuitsOn, this.def.ambient);
  }

  // ---------- What the agent can do now ----------

  itemNear(kind: Item["kind"]): Item | null {
    for (const it of this.def.items) {
      if (it.kind === kind && cheb(it.at, this.player.at) === 1) return it;
    }
    return null;
  }

  lockedNear(): Pt | null {
    for (let k = 0; k < 8; k += 2) {
      const d = DIRS[k] as Pt;
      const q = { x: this.player.at.x + d.x, y: this.player.at.y + d.y };
      if (this.grid.get(q.x, q.y) === T.Locked) return q;
    }
    return null;
  }

  /** What "use" would do here, for the interface. */
  useHint(): "key" | "photo" | "unlock" | "panel" | null {
    if (this.lockedNear() && this.player.key) return "unlock";
    if (!this.player.photo && this.itemNear("document") && !this.lockedNear()) return "photo";
    if (!this.player.key && this.itemNear("key")) return "key";
    if (this.itemNear("panel")) return "panel";
    return null;
  }

  pickOdds(): number {
    return chance(this.agent.technique, this.def.lock);
  }

  bluffTarget(): number {
    return 9 + this.alarm + (this.player.photo ? 1 : 0);
  }

  bluffOdds(): number {
    return chance(this.agent.nerve, this.bluffTarget());
  }

  hidden(): boolean {
    return this.grid.get(this.player.at.x, this.player.at.y) === T.Hide;
  }

  canThrowAt(p: Pt): boolean {
    if (this.player.coins <= 0) return false;
    if (Math.hypot(p.x - this.player.at.x, p.y - this.player.at.y) > 6) return false;
    if (!this.grid.walkable(p.x, p.y)) return false;
    return lineOfSight(this.player.at, p, transparency(this.grid, this.occupied()));
  }

  // ---------- Acting ----------

  /** Plays one action. Returns false, changing nothing, if the action is not possible now. */
  act(a: Action): boolean {
    if (this.status === "done") return false;
    if (this.status === "confront" && a.t !== "bluff" && a.t !== "flee") return false;
    if (this.status === "play" && (a.t === "bluff" || a.t === "flee")) return false;
    this.events = [];
    let ticks = 1;
    let looked = false;
    switch (a.t) {
      case "step":
      case "run": {
        const steps = a.t === "run" ? 2 : 1;
        let moved = false;
        for (let i = 0; i < steps; i++) {
          const d = DIRS[a.d] as Pt;
          const to = { x: this.player.at.x + d.x, y: this.player.at.y + d.y };
          if (!canStep(this.grid, this.player.at, to) || this.guards.some((g) => eq(g.at, to))) break;
          this.player.at = to;
          this.player.facing = a.d;
          moved = true;
          if (a.t === "run") this.noise(to, 4);
          this.look();
          looked = true;
          if (this.status !== "play") break;
        }
        if (!moved) return false;
        break;
      }
      case "wait":
        break;
      case "pick": {
        const door = this.lockedNear();
        if (!door) return false;
        if (this.player.pickLeft === 0) {
          const r = roll(this.dice, this.agent.technique, this.def.lock);
          this.events.push({ k: "dice", what: "pick", roll: r });
          // A good roll opens it in two turns; a miss still opens it, slowly. Never more than five.
          this.player.pickLeft = r.margin >= 3 ? 2 : r.ok ? 3 : 5;
        }
        ticks = 0;
        looked = true;
        // Pick turn by turn; stop if anyone starts looking this way.
        while (this.player.pickLeft > 0 && this.status === "play") {
          this.noise(this.player.at, 1);
          this.player.pickLeft--;
          this.tick();
          if (this.guards.some((g) => g.mode === "alert" || (g.sight && g.suspicion >= 35))) break;
        }
        if (this.player.pickLeft === 0 && this.status === "play") {
          this.grid.set(door.x, door.y, T.Door);
          this.player.picked = true;
          this.events.push({ k: "unlock", at: door });
          this.light = this.computeLight();
        }
        break;
      }
      case "use": {
        const hint = this.useHint();
        if (!hint) return false;
        if (hint === "unlock") {
          const door = this.lockedNear() as Pt;
          this.grid.set(door.x, door.y, T.Door);
          this.events.push({ k: "unlock", at: door });
          this.light = this.computeLight();
        } else if (hint === "key") {
          this.player.key = true;
          this.events.push({ k: "key" });
        } else if (hint === "photo") {
          // Two turns over the document; the shutter is quiet.
          this.tick();
          if (this.status !== "play") break;
          this.player.photo = true;
          this.events.push({ k: "photo" });
        } else {
          const panel = this.itemNear("panel") as Item;
          const c = panel.circuit ?? 0;
          const on = !this.circuitsOn.has(c);
          if (on) this.circuitsOn.add(c);
          else this.circuitsOn.delete(c);
          this.noise(this.player.at, 1);
          this.light = this.computeLight();
          this.events.push({ k: "lights", circuit: c, on });
          if (!on) this.fixLater = { circuit: c, in: 2 };
        }
        break;
      }
      case "throw": {
        if (!this.canThrowAt(a.at)) return false;
        this.player.coins--;
        this.noise(a.at, 4);
        break;
      }
      case "leave": {
        if (!this.def.exits.some((e) => eq(e, this.player.at))) return false;
        this.finish(this.player.photo ? this.grade() : "aborted");
        this.log.push(a);
        return true;
      }
      case "bluff": {
        const r = roll(this.dice, this.agent.nerve, this.bluffTarget());
        this.events.push({ k: "dice", what: "bluff", roll: r });
        const g = this.guards.find((x) => x.id === this.confronting);
        this.bluffed = true;
        if (!r.ok || !g) {
          this.finish("captured");
        } else {
          // The guard believes the cover story and walks the agent toward the way out.
          g.mode = "return";
          g.suspicion = 20;
          g.target = null;
          g.hurry = false;
          for (const o of this.guards) if (o.mode === "alert") o.mode = "search", o.searchLeft = 1, o.timer = 0;
          this.status = "play";
          this.confronting = null;
        }
        this.log.push(a);
        return true;
      }
      case "flee": {
        this.status = "play";
        const g = this.guards.find((x) => x.id === this.confronting);
        this.confronting = null;
        // Breaking free costs the guard their next turn: the agent's next move gets a head start.
        if (g) g.timer = -1;
        ticks = 0;
        looked = true;
        break;
      }
    }
    if (!looked) this.look();
    for (let i = 0; i < ticks && this.status === "play"; i++) this.tick();
    this.log.push(a);
    return true;
  }

  private finish(o: Outcome): void {
    this.status = "done";
    this.outcome = o;
    this.events.push({ k: "end", outcome: o });
  }

  private grade(): Outcome {
    if (this.bluffed || this.spotted) return "burned";
    if (this.alarm > 0) return "loud";
    if (this.peak < 35) return "ghost";
    return "quiet";
  }

  private noise(at: Pt, loud: number): void {
    this.noises.push({ at, loud });
    this.events.push({ k: "noise", at, loud });
  }

  private occupied(): Set<number> {
    const s = new Set<number>();
    for (const g of this.guards) s.add(g.at.y * this.grid.w + g.at.x);
    s.add(this.player.at.y * this.grid.w + this.player.at.x);
    return s;
  }

  /** One turn of the world: guards move, then look and listen. */
  private tick(): void {
    this.turn++;
    if (this.fixLater && --this.fixLater.in <= 0) {
      this.sendFixer(this.fixLater.circuit);
      this.fixLater = null;
    }
    for (const g of this.guards) this.guardAct(g);
    this.look();
    if (this.status === "play" && this.turn >= DAWN) this.finish("dawn");
  }

  // ---------- Guards: senses ----------

  /** Every guard looks and listens. */
  private look(): void {
    if (this.status === "done") return;
    const see = transparency(this.grid, this.occupied());
    const hidden = this.hidden();
    const bonus = this.alarm > 0 ? 1 : 0;
    for (const g of this.guards) {
      g.sight = false;
      const visible = !hidden && sees(this.grid, { at: g.at, facing: g.facing, bonus }, this.player.at, this.light, see);
      const searching = g.mode === "investigate" || g.mode === "look" || g.mode === "search" || g.mode === "alert";
      if (hidden && searching && cheb(g.at, this.player.at) === 1) {
        // A guard who is searching checks the cupboard right beside them.
        this.events.push({ k: "found", guard: g.id });
        this.raise(g);
        continue;
      }
      if (visible) {
        g.sight = true;
        g.suspicion = Math.min(100, g.suspicion + this.gain(g));
        g.lastSeen = this.player.at;
        if (g.suspicion >= 100) this.raise(g);
        else if (g.suspicion >= 35 && (g.mode === "patrol" || g.mode === "return" || g.mode === "fix")) {
          g.mode = "notice";
          g.target = this.player.at;
          g.timer = 1;
          this.events.push({ k: "notice", guard: g.id });
        } else if (g.mode === "look" || g.mode === "search" || g.mode === "investigate") {
          g.target = this.player.at;
          g.mode = "investigate";
        }
      }
      this.peak = Math.max(this.peak, g.suspicion);
    }
    // Noises.
    for (const n of this.noises) {
      const reach = hearing(this.grid, n.at, n.loud);
      for (const g of this.guards) {
        if (g.mode === "alert" || !reach.has(g.at.y * this.grid.w + g.at.x)) continue;
        g.suspicion = Math.max(g.suspicion, 40);
        g.mode = "notice";
        g.target = n.at;
        g.timer = 1;
        this.events.push({ k: "notice", guard: g.id });
      }
    }
    this.noises = [];
    this.peak = Math.max(this.peak, ...this.guards.map((g) => g.suspicion));
    // An alerted guard next to the agent, seeing them: face to face.
    if (this.status === "play") {
      const g = this.guards.find((x) => x.mode === "alert" && x.sight && cheb(x.at, this.player.at) === 1 && x.timer >= 0);
      if (g) {
        this.status = "confront";
        this.confronting = g.id;
        this.events.push({ k: "confront", guard: g.id });
      }
    }
  }

  /** How much suspicion one look adds: close, lit and careless is worst. */
  gain(g: GuardState): number {
    const d = Math.hypot(this.player.at.x - g.at.x, this.player.at.y - g.at.y);
    if (d < 1.6) return 100;
    const lvl = this.light[this.player.at.y * this.grid.w + this.player.at.x] as Light;
    const range = (SIGHT[lvl] as number) + (this.alarm > 0 ? 1 : 0);
    const base = lvl === Light.Lit ? 70 : lvl === Light.Dim ? 45 : 30;
    const skill = 1.3 - 0.15 * this.agent.discretion;
    return Math.round(Math.max(10, base * (1 - d / (range + 2))) * skill + (this.alarm > 0 ? 15 : 0));
  }

  /** A guard is sure: they shout into the radio and everyone converges. */
  private raise(g: GuardState): void {
    if (g.mode !== "alert") this.events.push({ k: "spotted", guard: g.id });
    g.mode = "alert";
    g.suspicion = 100;
    g.hurry = true;
    g.lastSeen = this.player.at;
    g.target = this.player.at;
    this.spotted = true;
    this.alarm = Math.min(3, this.alarm + (this.alarm === 0 ? 1 : 0));
    for (const o of this.guards) {
      if (o === g || o.mode === "alert") continue;
      o.mode = "investigate";
      o.target = this.player.at;
      o.hurry = true;
      o.suspicion = Math.max(o.suspicion, 60);
      this.events.push({ k: "radio", guard: o.id });
    }
  }

  private sendFixer(circuit: number): void {
    const panel = this.def.panels.find((p) => p.circuit === circuit);
    if (!panel) return;
    let best: GuardState | null = null;
    let bestLen = Infinity;
    for (const g of this.guards) {
      if (g.mode !== "patrol" && g.mode !== "return") continue;
      const p = this.pathTo(g, panel.at, true);
      if (p && p.length < bestLen) {
        best = g;
        bestLen = p.length;
      }
    }
    if (best) {
      best.mode = "fix";
      best.target = panel.at;
      best.hurry = false;
    }
  }

  // ---------- Guards: moving ----------

  private pathTo(g: GuardState, to: Pt, nextTo = false): Pt[] | null {
    const blocked = (x: number, y: number) => this.grid.get(x, y) === T.Hide || (x === this.player.at.x && y === this.player.at.y && !this.hidden());
    if (!nextTo) return path(this.grid, g.at, to, blocked);
    let best: Pt[] | null = null;
    for (const d of DIRS) {
      const q = { x: to.x + d.x, y: to.y + d.y };
      if (!this.grid.walkable(q.x, q.y) || blocked(q.x, q.y)) continue;
      const p = path(this.grid, g.at, q, blocked);
      if (p && (!best || p.length < best.length)) best = p;
    }
    return best;
  }

  private moveAlong(g: GuardState, p: Pt[] | null, steps: number): boolean {
    if (!p || p.length < 2) return false;
    for (let i = 1; i <= steps && i < p.length; i++) {
      const next = p[i] as Pt;
      if (eq(next, this.player.at) || this.guards.some((o) => o !== g && eq(o.at, next))) break;
      g.facing = dirTo(g.at, next);
      g.at = next;
    }
    return true;
  }

  private guardAct(g: GuardState): void {
    const def = this.def.guards[g.id];
    if (!def) return;
    if (g.timer < 0) {
      // Grabbing at a fleeing agent costs the guard this turn.
      g.timer = 0;
      return;
    }
    switch (g.mode) {
      case "patrol": {
        const nextIdx = (g.routeIdx + 1) % def.route.length;
        const st = def.route[nextIdx];
        if (!st) return;
        if (eq(st.at, this.player.at)) {
          g.facing = dirTo(g.at, st.at);
          return;
        }
        g.routeIdx = nextIdx;
        g.at = st.at;
        g.facing = st.facing;
        g.suspicion = Math.max(0, g.suspicion - 5);
        return;
      }
      case "notice": {
        if (g.target) g.facing = dirTo(g.at, g.target);
        if (--g.timer <= 0) g.mode = "investigate";
        return;
      }
      case "investigate": {
        const target = g.target ?? g.at;
        if (cheb(g.at, target) <= (g.hurry ? 1 : 0) || eq(g.at, target)) {
          g.mode = "look";
          g.timer = 3;
          return;
        }
        if (!this.moveAlong(g, this.pathTo(g, target), g.hurry ? 2 : 1)) {
          g.mode = "look";
          g.timer = 2;
        }
        return;
      }
      case "look": {
        g.facing = ((g.facing + 2) % 8) as Dir;
        if (--g.timer <= 0) {
          g.mode = "search";
          g.searchLeft = g.hurry ? 3 : 2;
          g.target = null;
        }
        return;
      }
      case "search": {
        if (!g.target) {
          if (g.searchLeft <= 0) {
            g.mode = "return";
            g.hurry = false;
            return;
          }
          g.searchLeft--;
          g.target = this.searchPoint(g);
          if (!g.target) {
            g.mode = "return";
            return;
          }
        }
        if (eq(g.at, g.target)) {
          g.mode = "look";
          g.timer = 2;
          g.target = null;
          return;
        }
        if (!this.moveAlong(g, this.pathTo(g, g.target), g.hurry ? 2 : 1)) g.target = null;
        return;
      }
      case "return": {
        let best = -1;
        let bestD = Infinity;
        def.route.forEach((st, i) => {
          const d = Math.abs(st.at.x - g.at.x) + Math.abs(st.at.y - g.at.y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        const st = def.route[best];
        if (!st) return;
        if (eq(g.at, st.at)) {
          g.routeIdx = best;
          g.facing = st.facing;
          g.mode = "patrol";
          g.target = null;
          return;
        }
        if (!this.moveAlong(g, this.pathTo(g, st.at), 1)) {
          // Blocked: resume the round where they stand.
          g.mode = "patrol";
        }
        return;
      }
      case "alert": {
        const target = g.sight ? this.player.at : (g.lastSeen ?? g.at);
        if (!g.sight && cheb(g.at, target) <= 1) {
          g.mode = "search";
          g.searchLeft = 3;
          g.target = null;
          return;
        }
        if (cheb(g.at, target) > 1) this.moveAlong(g, this.pathTo(g, target), 2);
        else g.facing = dirTo(g.at, target);
        return;
      }
      case "fix": {
        const target = g.target;
        if (!target) {
          g.mode = "return";
          return;
        }
        if (cheb(g.at, target) === 1) {
          const panel = this.def.panels.find((p) => eq(p.at, target));
          if (panel && !this.circuitsOn.has(panel.circuit)) {
            this.circuitsOn.add(panel.circuit);
            this.light = this.computeLight();
            this.events.push({ k: "lights", circuit: panel.circuit, on: true });
          }
          g.mode = "return";
          g.target = null;
          return;
        }
        if (!this.moveAlong(g, this.pathTo(g, target, true), 1)) g.mode = "return";
        return;
      }
    }
  }

  /** A nearby place to check, chosen with the mission's own dice. */
  private searchPoint(g: GuardState): Pt | null {
    for (let i = 0; i < 20; i++) {
      const q = { x: g.at.x + this.ai.int(-4, 4), y: g.at.y + this.ai.int(-4, 4) };
      if (!this.grid.walkable(q.x, q.y) || this.grid.get(q.x, q.y) === T.Hide) continue;
      const p = path(this.grid, g.at, q);
      if (p && p.length <= 8) return q;
    }
    return null;
  }

  // ---------- For the interface ----------

  /** The tiles each guard watches right now. */
  cones(): Map<number, number[]> {
    const see = transparency(this.grid, this.occupied());
    const bonus = this.alarm > 0 ? 1 : 0;
    const out = new Map<number, number[]>();
    for (const g of this.guards) out.set(g.id, watched(this.grid, { at: g.at, facing: g.facing, bonus }, this.light, see));
    return out;
  }

  /** A full copy, to try an action without playing it. */
  clone(): Mission {
    const m = Object.create(Mission.prototype) as Mission;
    Object.assign(m, this, {
      grid: this.grid.clone(),
      player: { ...this.player },
      guards: this.guards.map((g) => ({ ...g })),
      circuitsOn: new Set(this.circuitsOn),
      log: this.log.slice(),
      events: [],
      dice: this.dice.clone(),
      ai: this.ai.clone(),
      noises: this.noises.slice(),
      fixLater: this.fixLater ? { ...this.fixLater } : null,
    });
    return m;
  }

  /** Where each guard will look after the agent waits one turn: the planning view. */
  forecast(): Map<number, number[]> {
    const copy = this.clone();
    if (copy.status !== "play") return new Map();
    copy.act({ t: "wait" });
    return copy.cones();
  }
}
