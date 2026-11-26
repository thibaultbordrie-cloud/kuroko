/**
 * Checks a pack before anyone plays it: first by reading it (every target exists, every
 * variable read is written somewhere), then by playing it hundreds of times with random
 * choices (no game gets stuck, every ending can be reached, every scene shows up).
 */
import { Rng } from "../core/rng.js";
import { readsOf, type Effect } from "./expr.js";
import type { Pack } from "./pack.js";
import { Story, randomHero } from "./story.js";

export interface Report {
  readonly errors: string[];
  readonly warnings: string[];
  readonly runs: number;
  readonly endings: Record<string, number>;
  readonly stuck: number;
  readonly unfinished: number;
  readonly unseen: string[];
  readonly beats: { readonly min: number; readonly median: number; readonly max: number };
}

const BUILTIN = new Set(["tour", "tension", "fem", "attire"]);

export function validate(pack: Pack, runs = 400, maxBeats = 800): Report {
  const errors: string[] = [];
  const warnings: string[] = [];
  const scenes = new Set(pack.scenes.map((s) => s.id));
  const endings = new Set(pack.endings.map((e) => e.id));
  const personas = new Set(pack.personas.map((p) => p.id));
  const written = new Set<string>();
  const read = new Map<string, string>();
  const targeted = new Set<string>([pack.start]);

  if (!scenes.has(pack.start)) errors.push(`debut « ${pack.start} » : aucune scène de ce nom`);
  const effects = (list: readonly Effect[], where: string) => {
    for (const e of list) {
      if (e.k === "set") {
        written.add(e.name);
        for (const v of readsOf(e.e)) read.set(v, where);
      } else if (e.k === "goto" || e.k === "later") {
        targeted.add(e.scene);
        if (!scenes.has(e.scene)) errors.push(`${where} : la scène « ${e.scene} » n'existe pas`);
      } else if (!endings.has(e.ending)) {
        errors.push(`${where} : la fin « ${e.ending} » n'existe pas`);
      }
    }
  };
  effects(pack.init, "init");
  for (const o of [...(pack.creation?.origins ?? []), ...(pack.creation?.flaws ?? [])]) effects(o.effects, `option ${o.id}`);
  for (const s of pack.scenes) {
    const at = `scène ${s.id} (ligne ${s.line})`;
    if (s.when) for (const v of readsOf(s.when)) read.set(v, at);
    for (const m of s.text.matchAll(/\{\??([\p{L}_][\p{L}\p{N}_.]*)[}:]/gu)) {
      const k = m[1] as string;
      if (!personas.has(k) && k !== "moi") read.set(k, at);
    }
    for (const c of s.choices) {
      const cat = `${at}, choix « ${c.text} » (ligne ${c.line})`;
      if (c.when) for (const v of readsOf(c.when)) read.set(v, cat);
      if (c.roll) for (const v of readsOf(c.roll)) read.set(v, cat);
      effects(c.effects, cat);
      effects(c.hit, cat);
      effects(c.partial, cat);
      effects(c.miss, cat);
    }
  }
  for (const [v, where] of read) {
    if (BUILTIN.has(v) || v.startsWith("vu.") || v.startsWith("origine.") || v.startsWith("faille.") || v.endsWith(".fem") || written.has(v) || pack.creation?.traits.includes(v)) continue;
    warnings.push(`${where} : « ${v} » est lu mais jamais modifié (il vaudra toujours 0)`);
  }
  for (const s of pack.scenes) {
    if (s.weight === 0 && !targeted.has(s.id)) errors.push(`scène ${s.id} : poids 0 et jamais appelée par « aller » ou « dans » : inatteignable`);
  }

  // Play it, many times.
  const rng = new Rng("validate");
  const ends: Record<string, number> = Object.fromEntries(pack.endings.map((e) => [e.id, 0]));
  const visited = new Set<string>();
  const lengths: number[] = [];
  let stuck = 0;
  let unfinished = 0;
  const stuckSamples: string[] = [];
  if (errors.length === 0) {
    for (let r = 0; r < runs; r++) {
      const st = new Story(pack, `v${r}`, [], randomHero(pack, rng));
      while (st.scene && st.beat < maxBeats) {
        const offers = st.offers();
        if (offers.length === 0) break;
        st.choose(rng.pick(offers).index);
      }
      for (const h of st.history) visited.add(h);
      lengths.push(st.beat);
      if (st.ending) ends[st.ending.id] = (ends[st.ending.id] ?? 0) + 1;
      else if (st.scene && st.offers().length === 0) {
        stuck++;
        if (stuckSamples.length < 3) stuckSamples.push(`dans « ${st.scene.id} » aucun choix n'est disponible (tour ${st.beat})`);
      } else if (st.stuck) {
        stuck++;
        if (stuckSamples.length < 3) stuckSamples.push(`après « ${st.history.at(-1)} », aucune scène ne peut suivre (tour ${st.beat})`);
      } else unfinished++;
    }
    for (const s of stuckSamples) errors.push(`impasse : ${s}`);
    // Each theme a player may refuse must not leave them stuck.
    const themes = [...new Set(pack.scenes.flatMap((s) => s.themes))];
    for (const theme of themes) {
      let blocked = 0;
      for (let r = 0; r < Math.min(60, runs); r++) {
        const st = new Story(pack, `l${theme}${r}`, [theme], randomHero(pack, rng));
        while (st.scene && st.beat < maxBeats) {
          const offers = st.offers();
          if (offers.length === 0) break;
          st.choose(rng.pick(offers).index);
        }
        if (!st.ending && (st.stuck || (st.scene && st.offers().length === 0))) blocked++;
      }
      if (blocked) warnings.push(`avec la ligne « ${theme} », ${blocked} parties sur ${Math.min(60, runs)} se bloquent`);
    }
    for (const [id, n] of Object.entries(ends)) if (n === 0) warnings.push(`fin « ${id} » jamais atteinte en ${runs} parties au hasard`);
    if (unfinished > 0) warnings.push(`${unfinished} parties sur ${runs} n'ont pas fini en ${maxBeats} tours`);
  }
  const unseen = pack.scenes.filter((s) => !visited.has(s.id)).map((s) => s.id);
  if (errors.length === 0) for (const id of unseen) warnings.push(`scène « ${id} » jamais jouée en ${runs} parties au hasard`);
  const sorted = lengths.slice().sort((a, b) => a - b);
  return {
    errors,
    warnings,
    runs: errors.length === 0 ? runs : 0,
    endings: ends,
    stuck,
    unfinished,
    unseen,
    beats: { min: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted.at(-1) ?? 0 },
  };
}
