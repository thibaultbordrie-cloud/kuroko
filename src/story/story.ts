/**
 * Plays a pack. The game state is a set of numbered variables; each scene ends on a choice;
 * the director picks the next scene from those whose conditions hold, keeping the tension
 * moving and the scenery changing. A game is saved as its seed and the list of choices:
 * loading replays them, so a save cannot be edited into a result that never happened.
 */
import { Rng } from "../core/rng.js";
import { evaluate, type Effect } from "./expr.js";
import type { Choice, Ending, Pack, Scene } from "./pack.js";

export const MAX_TENSION = 10;

export interface RollResult {
  readonly dice: readonly [number, number];
  readonly bonus: number;
  readonly total: number;
  readonly band: "hit" | "partial" | "miss";
}

export interface Offer {
  readonly index: number;
  readonly choice: Choice;
  /** Chance of 10+ and of 7+ when the choice rolls, else null. */
  readonly odds: { readonly hit: number; readonly partial: number } | null;
}

/** Chance that 2d6 + bonus reaches the target, exactly. */
export function chanceAtLeast(bonus: number, target: number): number {
  let ok = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (a + b + bonus >= target) ok++;
  return ok / 36;
}

export class Story {
  readonly pack: Pack;
  readonly seed: string;
  beat = 0;
  tension = 0;
  scene: Scene | null = null;
  ending: Ending | null = null;
  /** No scene could follow and no ending was reached: a hole in the pack. */
  stuck = false;
  /** The save: each entry is a choice index, or a change of the player's lines (themes never shown). */
  readonly log: (number | readonly string[])[] = [];
  /** Themes the player never wants to meet: scenes carrying one are never played. */
  private lines = new Set<string>();
  readonly history: string[] = [];
  last: { readonly scene: Scene; readonly choice: Choice; readonly roll: RollResult | null } | null = null;
  private readonly vars = new Map<string, number>();
  private readonly names = new Map<string, string>();
  private readonly byId = new Map<string, Scene>();
  private readonly endById = new Map<string, Ending>();
  private forced: string | null = null;
  private scheduled: { at: number; scene: string }[] = [];
  private readonly dice: Rng;
  private readonly director: Rng;

  constructor(pack: Pack, seed: string, lines: readonly string[] = []) {
    this.pack = pack;
    this.seed = seed;
    for (const s of pack.scenes) this.byId.set(s.id, s);
    for (const e of pack.endings) this.endById.set(e.id, e);
    const rng = new Rng(`${seed}/story`);
    const cast = rng.fork("cast");
    this.dice = rng.fork("dice");
    this.director = rng.fork("director");
    // Each persona gets a name from their pool; two personas never share one.
    const taken = new Set<string>();
    for (const p of pack.personas) {
      const free = p.names.filter((n) => !taken.has(n));
      const name = cast.pick(free.length ? free : p.names);
      taken.add(name);
      this.names.set(p.id, name);
    }
    this.lines = new Set(lines);
    this.apply(pack.init);
    this.forced = pack.start;
    this.advance();
  }

  static replay(pack: Pack, seed: string, log: readonly (number | readonly string[])[], lines: readonly string[] = []): Story {
    const s = new Story(pack, seed, lines);
    for (const c of log) {
      if (Array.isArray(c)) s.setLines(c as readonly string[]);
      else if (!s.choose(c as number)) throw new Error("cette sauvegarde ne se rejoue pas : elle a été modifiée ou vient d'une autre version du pack");
    }
    return s;
  }

  /** Changes the lines from the next scene on. Recorded in the save so a replay stays exact. */
  setLines(lines: readonly string[]): void {
    this.lines = new Set(lines);
    this.log.push([...lines].sort());
  }

  allowed(s: Scene): boolean {
    return !s.themes.some((t) => this.lines.has(t));
  }

  /**
   * Scene text for the reader. {persona} becomes a name, {variable} a value. A passage between
   * [montré] and [/montré] shows only when none of the scene's themes is veiled; one between
   * [voilé] and [/voilé] shows only when one is: the same moment, off screen.
   */
  text(scene: Scene, veiled: ReadonlySet<string> = new Set()): string {
    const veil = scene.themes.some((t) => veiled.has(t));
    const t = scene.text
      .replace(/\[montré\]([\s\S]*?)\[\/montré\]/g, (_, x: string) => (veil ? "" : x))
      .replace(/\[voilé\]([\s\S]*?)\[\/voilé\]/g, (_, x: string) => (veil ? x : ""));
    return this.render(t).replace(/\n{3,}/g, "\n\n").trim();
  }

  get(name: string): number {
    if (name === "tour") return this.beat;
    if (name === "tension") return this.tension;
    return this.vars.get(name) ?? 0;
  }

  /** Everything the save does not need but a player or a test may want to see. */
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.vars.entries()].sort());
  }

  /** Scene text with {persona} replaced by their name and {variable} by its value. */
  render(text: string): string {
    return text.replace(/\{([\p{L}_][\p{L}\p{N}_.]*)\}/gu, (_, k: string) => this.names.get(k) ?? String(this.get(k)));
  }

  name(persona: string): string | undefined {
    return this.names.get(persona);
  }

  offers(): Offer[] {
    const s = this.scene;
    if (!s) return [];
    const get = (n: string) => this.get(n);
    const out: Offer[] = [];
    s.choices.forEach((choice, index) => {
      if (choice.when && !evaluate(choice.when, get)) return;
      const odds = choice.roll ? (() => { const b = evaluate(choice.roll, get); return { hit: chanceAtLeast(b, 10), partial: chanceAtLeast(b, 7) }; })() : null;
      out.push({ index, choice, odds });
    });
    return out;
  }

  /** Plays a choice by its index in the scene. Returns false, changing nothing, if it is not offered. */
  choose(index: number): boolean {
    const s = this.scene;
    if (!s || !Number.isInteger(index) || !this.offers().some((o) => o.index === index)) return false;
    const choice = s.choices[index] as Choice;
    this.log.push(index);
    this.apply(choice.effects);
    let roll: RollResult | null = null;
    if (choice.roll) {
      const bonus = evaluate(choice.roll, (n) => this.get(n));
      const a = this.dice.int(1, 6);
      const b = this.dice.int(1, 6);
      const total = a + b + bonus;
      const band = total >= 10 ? "hit" : total >= 7 ? "partial" : "miss";
      roll = { dice: [a, b], bonus, total, band };
      this.apply(band === "hit" ? choice.hit : band === "partial" ? choice.partial : choice.miss);
    }
    this.last = { scene: s, choice, roll };
    this.beat++;
    this.advance();
    return true;
  }

  private apply(effects: readonly Effect[]): void {
    for (const e of effects) {
      switch (e.k) {
        case "set": {
          const v = evaluate(e.e, (n) => this.get(n));
          const old = this.get(e.name);
          const nv = e.op === "=" ? v : e.op === "+=" ? old + v : old - v;
          if (e.name === "tension") this.tension = clamp(nv, 0, MAX_TENSION);
          else this.vars.set(e.name, nv);
          break;
        }
        case "goto":
          this.forced = e.scene;
          break;
        case "later":
          this.scheduled.push({ at: this.beat + e.turns, scene: e.scene });
          break;
        case "end":
          this.ending = this.endById.get(e.ending) ?? null;
          if (!this.ending) this.stuck = true;
          break;
      }
    }
  }

  private advance(): void {
    this.scene = null;
    if (this.ending || this.stuck) return;
    let next: Scene | undefined;
    if (this.forced) {
      next = this.byId.get(this.forced);
      this.forced = null;
    } else {
      const due = this.scheduled.filter((x) => x.at <= this.beat).sort((a, b) => a.at - b.at)[0];
      if (due) {
        this.scheduled.splice(this.scheduled.indexOf(due), 1);
        next = this.byId.get(due.scene);
      } else {
        next = this.pick();
      }
    }
    // A forced or delayed scene that crosses one of the player's lines is skipped.
    if (next && !this.allowed(next)) next = this.pick();
    if (!next) {
      this.stuck = true;
      return;
    }
    this.enter(next);
  }

  private enter(s: Scene): void {
    this.scene = s;
    this.history.push(s.id);
    this.vars.set(`vu.${s.id}`, this.get(`vu.${s.id}`) + 1);
    this.tension = clamp(this.tension + s.tension, 0, MAX_TENSION);
  }

  /** The director: eligible scenes, urgent ones first, then weighted for pace and variety. */
  private pick(): Scene | undefined {
    const get = (n: string) => this.get(n);
    const prev = this.history.at(-1);
    const prevScene = prev ? this.byId.get(prev) : undefined;
    const eligible = this.pack.scenes.filter(
      (s) => s.weight > 0 && s.id !== prev && this.allowed(s) && (s.repeat || this.get(`vu.${s.id}`) === 0) && (!s.when || evaluate(s.when, get)),
    );
    if (eligible.length === 0) return undefined;
    const urgent = eligible.filter((s) => s.urgent);
    const pool = urgent.length ? urgent : eligible;
    // The tension the story wants now: it climbs over the game and breathes in waves.
    const target = Math.min(MAX_TENSION, 2 + this.beat / 12 + 2.5 * Math.sin(this.beat / 3));
    const w = pool.map((s) => {
      let x = s.weight / (1 + Math.abs(this.tension + s.tension - target));
      if (prevScene && s.place && s.place === prevScene.place) x *= 0.5;
      if (prevScene && s.view === prevScene.view) x *= 0.8;
      return x;
    });
    let r = this.director.next() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) {
      r -= w[i] as number;
      if (r <= 0) return pool[i];
    }
    return pool.at(-1);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
