/**
 * A pack is plain text, written by a person, read by this parser. It holds data only.
 *
 *   @pack                         @scene accueil            @fin partir
 *   titre: …                      vue: proche               titre: …
 *   debut: accueil                quand: semaine >= 2       ---
 *   init: argent = 3              ---                       Texte de la fin.
 *                                 Texte, {perso} inséré.
 *   @perso ren                    > Un choix
 *   noms: Lin Yu-ting | Chen …      si: argent > 0
 *                                   jet: charme
 *                                   effets: argent -= 1
 *                                   10+: aller suite
 *                                   7-9: …
 *                                   6-: …
 */
import { ExprError, parseEffects, parseExpr, type Effect, type Expr } from "./expr.js";

export type View = "proche" | "dossier" | "miroir";
const VIEWS: readonly View[] = ["proche", "dossier", "miroir"];

export interface Choice {
  readonly text: string;
  readonly when: Expr | null;
  readonly roll: Expr | null;
  readonly rollLabel: string;
  readonly effects: readonly Effect[];
  readonly hit: readonly Effect[];
  readonly partial: readonly Effect[];
  readonly miss: readonly Effect[];
  readonly line: number;
}

export interface Scene {
  readonly id: string;
  readonly view: View;
  readonly place: string;
  readonly when: Expr | null;
  readonly weight: number;
  readonly repeat: boolean;
  readonly urgent: boolean;
  readonly tension: number;
  readonly themes: readonly string[];
  readonly text: string;
  readonly choices: readonly Choice[];
  readonly line: number;
}

export interface Ending {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly line: number;
}

export interface Persona {
  readonly id: string;
  readonly names: readonly string[];
  readonly line: number;
}

export interface Pack {
  readonly title: string;
  readonly version: number;
  readonly age: number;
  readonly themes: readonly string[];
  readonly start: string;
  readonly init: readonly Effect[];
  readonly personas: readonly Persona[];
  readonly scenes: readonly Scene[];
  readonly endings: readonly Ending[];
}

export class PackError extends Error {
  constructor(readonly line: number, message: string) {
    super(`ligne ${line} : ${message}`);
  }
}

const ID = /^[\p{L}\p{N}_.-]+$/u;
const MAX_TEXT = 4_000_000;

interface Block {
  kind: string;
  id: string;
  line: number;
  head: [number, string, string][];
  body: [number, string][];
}

export function parsePack(src: string): Pack {
  if (src.length > MAX_TEXT) throw new PackError(0, "pack trop volumineux");
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let inBody = false;
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/\s+$/, "");
    if (/^\/\//.test(line)) return;
    const start = /^@(\p{L}+)(?:\s+(\S+))?$/u.exec(line);
    if (start) {
      cur = { kind: start[1] as string, id: start[2] ?? "", line: n, head: [], body: [] };
      blocks.push(cur);
      inBody = false;
      return;
    }
    if (!cur) {
      if (line.trim()) throw new PackError(n, "texte hors d'un bloc @…");
      return;
    }
    const b: Block = cur;
    if (!inBody) {
      if (line === "---") {
        inBody = true;
        return;
      }
      if (!line.trim()) return;
      const kv = /^([\p{L}-]+)\s*:\s*(.*)$/u.exec(line);
      if (!kv) throw new PackError(n, "attendu « clé: valeur » ou « --- »");
      b.head.push([n, (kv[1] as string).toLowerCase(), (kv[2] as string).trim()]);
      return;
    }
    b.body.push([n, line]);
  });

  let meta: Block | null = null;
  const personas: Persona[] = [];
  const scenes: Scene[] = [];
  const endings: Ending[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== "pack") {
      if (!ID.test(b.id)) throw new PackError(b.line, `identifiant manquant ou invalide après @${b.kind}`);
      const key = `${b.kind}:${b.id}`;
      if (seen.has(key)) throw new PackError(b.line, `« ${b.id} » est défini deux fois`);
      seen.add(key);
    }
    switch (b.kind) {
      case "pack":
        if (meta) throw new PackError(b.line, "un seul bloc @pack");
        meta = b;
        break;
      case "perso":
        personas.push(parsePersona(b));
        break;
      case "scene":
        scenes.push(parseScene(b));
        break;
      case "fin":
        endings.push(parseEnding(b));
        break;
      default:
        throw new PackError(b.line, `bloc inconnu @${b.kind}`);
    }
  }
  if (!meta) throw new PackError(1, "le bloc @pack manque");
  const m = meta as Block;
  const get = (k: string) => m.head.find((h) => h[1] === k);
  const title = get("titre")?.[2] ?? "";
  if (!title) throw new PackError(m.line, "titre manquant");
  const start = get("debut")?.[2] ?? "";
  if (!start) throw new PackError(m.line, "debut manquant");
  const init = get("init");
  return {
    title,
    version: num(get("version"), 1),
    age: num(get("age"), 18),
    themes: list(get("themes")?.[2]),
    start,
    init: init ? guard(init[0], () => parseEffects(init[2])) : [],
    personas,
    scenes,
    endings,
  };
}

function num(h: [number, string, string] | undefined, dflt: number): number {
  if (!h) return dflt;
  if (!/^-?\d+$/.test(h[2])) throw new PackError(h[0], `nombre attendu pour « ${h[1]} »`);
  return Number(h[2]);
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function yes(v: string): boolean {
  return /^(oui|vrai|yes|true)$/i.test(v);
}

function guard<T>(line: number, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ExprError) throw new PackError(line, e.message);
    throw e;
  }
}

function text(body: [number, string][]): string {
  return body.map(([, l]) => l).join("\n").trim().replace(/\n{3,}/g, "\n\n");
}

function parsePersona(b: Block): Persona {
  const names = b.head.find((h) => h[1] === "noms");
  const list = names ? names[2].split("|").map((s) => s.trim()).filter(Boolean) : [];
  if (list.length === 0) throw new PackError(b.line, `@perso ${b.id} : « noms » manquant`);
  return { id: b.id, names: list, line: b.line };
}

function parseEnding(b: Block): Ending {
  const t = b.head.find((h) => h[1] === "titre")?.[2] ?? "";
  if (!t) throw new PackError(b.line, `@fin ${b.id} : titre manquant`);
  return { id: b.id, title: t, text: text(b.body), line: b.line };
}

function parseScene(b: Block): Scene {
  let view: View = "proche";
  let place = "";
  let when: Expr | null = null;
  let weight = 1;
  let repeat = false;
  let urgent = false;
  let tension = 0;
  let themes: string[] = [];
  for (const [n, k, v] of b.head) {
    switch (k) {
      case "vue":
        if (!VIEWS.includes(v as View)) throw new PackError(n, `vue inconnue « ${v} » (proche, dossier, miroir)`);
        view = v as View;
        break;
      case "lieu":
        place = v;
        break;
      case "quand":
        when = guard(n, () => parseExpr(v));
        break;
      case "poids":
        weight = num([n, k, v], 1);
        if (weight < 0) throw new PackError(n, "poids négatif");
        break;
      case "repetable":
        repeat = yes(v);
        break;
      case "urgent":
        urgent = yes(v);
        break;
      case "tension":
        tension = num([n, k, v.replace(/^\+/, "")], 0);
        break;
      case "themes":
        themes = list(v);
        break;
      default:
        throw new PackError(n, `clé inconnue « ${k} » dans @scene`);
    }
  }
  // Body: prose, then choices introduced by "> ".
  const prose: [number, string][] = [];
  const choices: Choice[] = [];
  let c: { text: string; line: number; fields: [number, string, string][] } | null = null;
  const flush = () => {
    if (c) choices.push(buildChoice(c));
    c = null;
  };
  for (const [n, l] of b.body) {
    const opt = /^>\s+(.+)$/.exec(l);
    if (opt) {
      flush();
      c = { text: (opt[1] as string).trim(), line: n, fields: [] };
      continue;
    }
    if (c) {
      if (!l.trim()) continue;
      const f = /^\s+([\p{L}\p{N}+-]+)\s*:\s*(.*)$/u.exec(l);
      if (!f) throw new PackError(n, "dans un choix, attendu une ligne indentée « clé: valeur »");
      (c as { fields: [number, string, string][] }).fields.push([n, (f[1] as string).toLowerCase(), (f[2] as string).trim()]);
      continue;
    }
    prose.push([n, l]);
  }
  flush();
  if (choices.length === 0) throw new PackError(b.line, `@scene ${b.id} : aucun choix (une scène doit finir sur un choix)`);
  return { id: b.id, view, place, when, weight, repeat, urgent, tension, themes, text: text(prose), choices, line: b.line };
}

function buildChoice(c: { text: string; line: number; fields: [number, string, string][] }): Choice {
  let when: Expr | null = null;
  let roll: Expr | null = null;
  let rollLabel = "";
  let effects: Effect[] = [];
  let hit: Effect[] = [];
  let partial: Effect[] = [];
  let miss: Effect[] = [];
  for (const [n, k, v] of c.fields) {
    switch (k) {
      case "si":
        when = guard(n, () => parseExpr(v));
        break;
      case "jet":
        roll = guard(n, () => parseExpr(v));
        rollLabel = v;
        break;
      case "effets":
        effects = guard(n, () => parseEffects(v));
        break;
      case "10+":
        hit = guard(n, () => parseEffects(v));
        break;
      case "7-9":
        partial = guard(n, () => parseEffects(v));
        break;
      case "6-":
        miss = guard(n, () => parseEffects(v));
        break;
      default:
        throw new PackError(n, `clé de choix inconnue « ${k} » (si, jet, effets, 10+, 7-9, 6-)`);
    }
  }
  if (!roll && (hit.length || partial.length || miss.length)) throw new PackError(c.line, "résultats 10+/7-9/6- sans « jet »");
  return { text: c.text, when, roll, rollLabel, effects, hit, partial, miss, line: c.line };
}
