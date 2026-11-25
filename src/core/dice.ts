/**
 * Skill checks, tabletop style: two six-sided dice plus a skill, against a target.
 * The odds are computed exactly and shown before the player commits.
 */
import type { Rng } from "./rng.js";

export interface Roll {
  readonly dice: readonly [number, number];
  readonly bonus: number;
  readonly target: number;
  readonly total: number;
  readonly ok: boolean;
  /** How far above (or below) the target. */
  readonly margin: number;
}

export function roll(rng: Rng, bonus: number, target: number): Roll {
  const a = rng.int(1, 6);
  const b = rng.int(1, 6);
  const total = a + b + bonus;
  return { dice: [a, b], bonus, target, total, ok: total >= target, margin: total - target };
}

/** Exact chance that 2d6 + bonus reaches the target, from 0 to 1. */
export function chance(bonus: number, target: number): number {
  let hits = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (a + b + bonus >= target) hits++;
  return hits / 36;
}
