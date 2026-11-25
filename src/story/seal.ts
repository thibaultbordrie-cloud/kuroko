/**
 * A sealed pack is the pack's text compressed into a small JSON envelope with its checksum.
 * Opening the file by mistake shows nothing of the story (a curtain against spoilers, not a
 * safe), and a file damaged or changed after sealing is refused. Works in browsers and Node.
 */
export interface Sealed {
  readonly kuroko: "pack";
  readonly v: 1;
  readonly title: string;
  readonly age: number;
  readonly themes: readonly string[];
  readonly sha256: string;
  readonly data: string;
}

const MAX_SEALED = 8_000_000;

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function seal(text: string, meta: { title: string; age: number; themes: readonly string[] }): Promise<Sealed> {
  const raw = new TextEncoder().encode(text);
  const packed = await pipe(raw, new CompressionStream("deflate-raw"));
  return { kuroko: "pack", v: 1, title: meta.title, age: meta.age, themes: [...meta.themes], sha256: await sha256(raw), data: toBase64(packed) };
}

/** Reads a sealed file. Throws with a plain message on anything unexpected. */
export async function unseal(fileText: string): Promise<{ meta: Sealed; text: string }> {
  if (fileText.length > MAX_SEALED) throw new Error("fichier trop volumineux pour un pack");
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(fileText) as Record<string, unknown>;
  } catch {
    throw new Error("ce fichier n'est pas un pack Kuroko");
  }
  if (o.kuroko !== "pack" || o.v !== 1 || typeof o.data !== "string" || typeof o.sha256 !== "string" || typeof o.title !== "string") {
    throw new Error("ce fichier n'est pas un pack Kuroko");
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await pipe(fromBase64(o.data), new DecompressionStream("deflate-raw"));
  } catch {
    throw new Error("pack abîmé : impossible de l'ouvrir");
  }
  if ((await sha256(raw)) !== o.sha256) throw new Error("pack modifié ou abîmé : la somme de contrôle ne correspond pas");
  const age = typeof o.age === "number" ? o.age : 18;
  const themes = Array.isArray(o.themes) ? o.themes.filter((t): t is string => typeof t === "string") : [];
  return { meta: { kuroko: "pack", v: 1, title: o.title, age, themes, sha256: o.sha256, data: o.data }, text: new TextDecoder().decode(raw) };
}
