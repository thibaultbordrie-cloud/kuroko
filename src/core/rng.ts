/**
 * Deterministic randomness. Every random choice in Kuroko comes from a seed, so a mission,
 * a campaign or a whole game can be replayed exactly from its seed and the player's actions.
 *
 * sfc32 (Chris Doty-Humphrey's Small Fast Counting generator): 128 bits of state, passes
 * PractRand, and is easy to reproduce in any language.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string | number) {
    const h = hash128(String(seed));
    this.a = h[0];
    this.b = h[1];
    this.c = h[2];
    this.d = h[3];
    for (let i = 0; i < 12; i++) this.next();
  }

  /** A float in [0, 1). */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** An integer in [min, max], both included. */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`empty range ${min}..${max}`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick from an empty list");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  /** An exact copy: both continue with the same numbers. */
  clone(): Rng {
    const r = Object.create(Rng.prototype) as Rng;
    Object.assign(r, { a: this.a, b: this.b, c: this.c, d: this.d });
    return r;
  }

  /** An independent stream for one purpose: dice never shift the level generator, and the reverse. */
  fork(label: string): Rng {
    return new Rng(`${this.a}:${this.b}:${this.c}:${this.d}:${label}`);
  }
}

/** cyrb128: a fast string hash giving four 32-bit seeds. */
export function hash128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** A short code a player can read aloud or type to share a mission: 8 letters, no 0/O or 1/I. */
export function seedCode(rng: Rng): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[rng.int(0, alphabet.length - 1)];
  return s;
}
