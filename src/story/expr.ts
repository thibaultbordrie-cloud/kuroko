/**
 * The small language packs use for conditions and effects. It is parsed and evaluated here,
 * never handed to the JavaScript engine: a pack can read and change game variables, nothing else.
 *
 *   quand: semaine >= 3 et non vu.bar et (confiance.ren > 2 ou dette.ren)
 *   effets: confiance.ren += 1; dans 3 suite.appel; aller bar.sortie
 */

export type Expr =
  | { readonly k: "num"; readonly v: number }
  | { readonly k: "var"; readonly name: string }
  | { readonly k: "not"; readonly e: Expr }
  | { readonly k: "neg"; readonly e: Expr }
  | { readonly k: "bin"; readonly op: BinOp; readonly a: Expr; readonly b: Expr };

type BinOp = "+" | "-" | "*" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type Effect =
  | { readonly k: "set"; readonly name: string; readonly op: "=" | "+=" | "-="; readonly e: Expr }
  | { readonly k: "goto"; readonly scene: string }
  | { readonly k: "later"; readonly turns: number; readonly scene: string }
  | { readonly k: "end"; readonly ending: string };

export class ExprError extends Error {}

const NAME = /^[\p{L}_][\p{L}\p{N}_.]*/u;
const WORDS: Record<string, string> = { et: "and", and: "and", ou: "or", or: "or", non: "not", not: "not", vrai: "true", true: "true", faux: "false", false: "false" };

interface Tok {
  readonly t: "num" | "name" | "op" | "(" | ")" | "end";
  readonly v: string;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const num = /^\d+/.exec(rest);
    if (num) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      const w = name[0].replace(/\.+$/, "");
      out.push({ t: "name", v: w });
      i += w.length;
      continue;
    }
    const op = /^(==|!=|<=|>=|\+=|-=|[<>=+\-*])/.exec(rest);
    if (op) {
      out.push({ t: "op", v: op[0] });
      i += op[0].length;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ t: c, v: c });
      i++;
      continue;
    }
    throw new ExprError(`caractère inattendu « ${c} »`);
  }
  out.push({ t: "end", v: "" });
  return out;
}

const PREC: Record<string, number> = { or: 1, and: 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6 };

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i] as Tok;
  }

  private next(): Tok {
    return this.toks[this.i++] as Tok;
  }

  done(): void {
    if (this.peek().t !== "end") throw new ExprError(`en trop : « ${this.peek().v} »`);
  }

  private opOf(t: Tok): string | null {
    if (t.t === "op" && t.v in PREC) return t.v === "=" ? null : t.v;
    if (t.t === "name" && (WORDS[t.v] === "and" || WORDS[t.v] === "or")) return WORDS[t.v] as string;
    return null;
  }

  expr(min = 1): Expr {
    let a = this.unary();
    for (;;) {
      const op = this.opOf(this.peek());
      if (!op || (PREC[op] as number) < min) return a;
      this.next();
      const b = this.expr((PREC[op] as number) + 1);
      a = { k: "bin", op: op as BinOp, a, b };
    }
  }

  private unary(): Expr {
    const t = this.next();
    if (t.t === "num") return { k: "num", v: Number(t.v) };
    if (t.t === "(") {
      const e = this.expr();
      if (this.next().t !== ")") throw new ExprError("parenthèse non fermée");
      return e;
    }
    if (t.t === "op" && t.v === "-") return { k: "neg", e: this.unary() };
    if (t.t === "name") {
      const w = WORDS[t.v];
      if (w === "not") return { k: "not", e: this.expr(3) };
      if (w === "true") return { k: "num", v: 1 };
      if (w === "false") return { k: "num", v: 0 };
      if (w) throw new ExprError(`« ${t.v} » mal placé`);
      return { k: "var", name: t.v };
    }
    throw new ExprError(t.t === "end" ? "expression incomplète" : `« ${t.v} » inattendu`);
  }
}

export function parseExpr(src: string): Expr {
  const p = new Parser(tokenize(src));
  const e = p.expr();
  p.done();
  return e;
}

/** Effects are separated by ";". */
export function parseEffects(src: string): Effect[] {
  const out: Effect[] = [];
  for (const raw of src.split(";")) {
    const part = raw.trim();
    if (!part || part === "rien") continue;
    let m = /^aller\s+([\p{L}\p{N}_.-]+)$/u.exec(part);
    if (m) {
      out.push({ k: "goto", scene: m[1] as string });
      continue;
    }
    m = /^dans\s+(\d+)\s+([\p{L}\p{N}_.-]+)$/u.exec(part);
    if (m) {
      out.push({ k: "later", turns: Number(m[1]), scene: m[2] as string });
      continue;
    }
    m = /^fin\s+([\p{L}\p{N}_.-]+)$/u.exec(part);
    if (m) {
      out.push({ k: "end", ending: m[1] as string });
      continue;
    }
    m = /^([\p{L}_][\p{L}\p{N}_.]*)\s*(\+=|-=|=)\s*(.+)$/u.exec(part);
    if (m) {
      out.push({ k: "set", name: m[1] as string, op: m[2] as "=" | "+=" | "-=", e: parseExpr(m[3] as string) });
      continue;
    }
    throw new ExprError(`effet inconnu : « ${part} »`);
  }
  return out;
}

export type Lookup = (name: string) => number;

export function evaluate(e: Expr, get: Lookup): number {
  switch (e.k) {
    case "num":
      return e.v;
    case "var":
      return get(e.name);
    case "not":
      return evaluate(e.e, get) ? 0 : 1;
    case "neg":
      return -evaluate(e.e, get);
    case "bin": {
      const a = evaluate(e.a, get);
      if (e.op === "and") return a ? (evaluate(e.b, get) ? 1 : 0) : 0;
      if (e.op === "or") return a ? 1 : evaluate(e.b, get) ? 1 : 0;
      const b = evaluate(e.b, get);
      switch (e.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "==": return a === b ? 1 : 0;
        case "!=": return a !== b ? 1 : 0;
        case "<": return a < b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
      }
    }
  }
}

/** Every variable an expression reads, for the validator. */
export function readsOf(e: Expr, out = new Set<string>()): Set<string> {
  if (e.k === "var") out.add(e.name);
  else if (e.k === "not" || e.k === "neg") readsOf(e.e, out);
  else if (e.k === "bin") {
    readsOf(e.a, out);
    readsOf(e.b, out);
  }
  return out;
}
