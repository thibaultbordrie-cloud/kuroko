import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, parseEffects, parseExpr } from "../src/story/expr.js";
import { PackError, parsePack } from "../src/story/pack.js";
import { seal, unseal } from "../src/story/seal.js";
import { Story, chanceAtLeast } from "../src/story/story.js";
import { validate } from "../src/story/validate.js";

const PACK = `
// A tiny pack for the tests: two endings, a roll, a delayed consequence.
@pack
titre: Essai
debut: quai
init: argent = 2

@perso inconnu
noms: Alpha | Bravo | Charlie

@perso amie
noms: Delta | Echo

@scene quai
vue: proche
---
{inconnu} attend sur le quai. Tu as {argent} billets.

> Payer
  si: argent > 0
  effets: argent -= 1; confiance += 1; dans 2 rappel
> Bluffer
  jet: confiance
  10+: confiance += 2
  7-9: confiance += 1; dette = 1
  6-: soupcon += 2

@scene bar
lieu: bar
repetable: oui
quand: non fini
---
{amie} te sert un verre.
> Écouter
  effets: confiance += 1
> Partir
  effets: soupcon += 1

@scene rue
lieu: rue
repetable: oui
quand: non fini
---
La pluie ne s'arrête pas.
> Attendre
  effets: confiance += 1
> Fouiller les poubelles
  effets: soupcon += 1

@scene rappel
poids: 0
---
Le téléphone sonne.
> Répondre
  effets: aller final

@scene ruelle
quand: soupcon >= 2
urgent: oui
---
Quelqu'un te suit.
> Courir
  effets: fin pris

@scene final
quand: confiance >= 3
---
Le train arrive.
> Monter
  effets: fini = 1; fin parti

@fin parti
titre: Parti
---
Tu es parti.

@fin pris
titre: Pris
---
Ils t'ont eu.
`;

test("expressions: arithmetic, logic in French or English, missing variables are 0", () => {
  const get = (n: string) => ({ a: 3, "x.y": 2 } as Record<string, number>)[n] ?? 0;
  assert.equal(evaluate(parseExpr("a + x.y * 2"), get), 7);
  assert.equal(evaluate(parseExpr("a >= 3 et non inconnu"), get), 1);
  assert.equal(evaluate(parseExpr("(a < 2 ou x.y == 2) and -a < 0"), get), 1);
  assert.equal(evaluate(parseExpr("rien_du_tout"), get), 0);
  assert.throws(() => parseExpr("a +"), /incomplète/);
  assert.throws(() => parseExpr("a ; b"), /inattendu/);
  assert.deepEqual(parseEffects("x += 2; aller suite; dans 3 appel; fin mort").map((e) => e.k), ["set", "goto", "later", "end"]);
});

test("a pack cannot run code: names like constructor or __proto__ are just variables", () => {
  const p = parsePack(PACK.replace("argent -= 1;", "argent -= 1; constructor = 5; __proto__ = 1;"));
  const s = new Story(p, "proto");
  assert.ok(s.choose(0));
  assert.equal(s.get("constructor"), 5);
  assert.equal(s.get("__proto__"), 1);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("parse errors name the line", () => {
  assert.throws(() => parsePack("@pack\ntitre: x\ndebut: a\n\n@scene a\n---\nTexte\n> Choix\n  effets: x +"), (e: unknown) => e instanceof PackError && e.line === 9);
  assert.throws(() => parsePack("@pack\ntitre: x\ndebut: a\n@scene a\nvue: lointaine\n---\n> c"), /ligne 5/);
  assert.throws(() => parsePack("@pack\ntitre: x\ndebut: a\n@scene a\n---\nSans choix"), /aucun choix/);
});

test("same seed, same choices: same story; names come from the pools, never shared", () => {
  const p = parsePack(PACK);
  const a = new Story(p, "graine");
  const b = new Story(p, "graine");
  assert.equal(a.name("inconnu"), b.name("inconnu"));
  assert.notEqual(a.name("inconnu"), a.name("amie"));
  assert.match(a.render(a.scene?.text ?? ""), /^(Alpha|Bravo|Charlie) attend sur le quai\. Tu as 2 billets\.$/);
  for (const st of [a, b]) for (let i = 0; i < 30 && st.scene; i++) st.choose((st.offers()[0] ?? { index: 0 }).index);
  assert.deepEqual(a.history, b.history);
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test("a save replays exactly; a changed save is refused", () => {
  const p = parsePack(PACK);
  const s = new Story(p, "save");
  for (let i = 0; i < 20 && s.scene; i++) s.choose((s.offers().at(-1) ?? { index: 0 }).index);
  const r = Story.replay(p, "save", s.log);
  assert.deepEqual(r.history, s.history);
  assert.equal(r.ending?.id, s.ending?.id);
  // Choosing "Payer" with no money left, or a choice that does not exist, cannot be replayed.
  assert.throws(() => Story.replay(p, "save", [0, 0, 0, 0, 0, 0, 0, 0, 7]));
  assert.throws(() => Story.replay(p, "save", [9]));
});

test("conditions hide choices; rolls show exact odds; delayed scenes arrive on time", () => {
  const p = parsePack(PACK);
  const s = new Story(p, "rules");
  assert.equal(s.offers().length, 2);
  const bluff = s.offers()[1];
  assert.deepEqual(bluff?.odds, { hit: chanceAtLeast(0, 10), partial: chanceAtLeast(0, 7) });
  assert.equal(chanceAtLeast(0, 7), 21 / 36);
  s.choose(0); // pay: the call comes two turns later
  const seen: string[] = [];
  for (let i = 0; i < 3 && s.scene && !s.history.includes("rappel"); i++) {
    seen.push(s.scene.id);
    const o = s.offers();
    s.choose((o.find((x) => x.choice.text === "Écouter") ?? (o[0] as (typeof o)[number])).index);
  }
  assert.ok(s.history.includes("rappel"), `history: ${s.history.join(" > ")}`);
  assert.equal(s.history.indexOf("rappel"), 2);
});

test("the validator plays the pack: no dead end, both endings reachable", () => {
  const r = validate(parsePack(PACK), 300);
  assert.deepEqual(r.errors, []);
  assert.equal(r.stuck, 0);
  assert.ok((r.endings.parti ?? 0) > 0 && (r.endings.pris ?? 0) > 0, JSON.stringify(r.endings));
});

test("the validator finds the holes: a missing target, a dead end, an ending nobody reaches", () => {
  const broken = PACK.replace("aller final", "aller nulle-part");
  assert.ok(validate(parsePack(broken)).errors.some((e) => /nulle-part/.test(e)));
  const dead = PACK.replaceAll("quand: non fini", "quand: tour > 1000");
  const r = validate(parsePack(dead), 100);
  assert.ok(r.stuck > 0 && r.errors.some((e) => /impasse/.test(e)), JSON.stringify(r.errors));
  const lonely = PACK + "\n@fin oubli\ntitre: Oubli\n---\nPersonne ne vient ici.\n";
  assert.ok(validate(parsePack(lonely), 100).warnings.some((w) => /oubli/.test(w)));
});

test("sealed packs open again, and a changed byte is refused", async () => {
  const s = await seal(PACK, { title: "Essai", age: 18, themes: ["test"] });
  assert.ok(!JSON.stringify(s).includes("quai"), "the sealed file must not show the story");
  const back = await unseal(JSON.stringify(s));
  assert.equal(back.text, PACK);
  const bad = { ...s, sha256: s.sha256.replace(/^./, (c) => (c === "0" ? "1" : "0")) };
  await assert.rejects(unseal(JSON.stringify(bad)), /somme de contrôle/);
  await assert.rejects(unseal("{}"), /pas un pack/);
});

test("lines remove scenes for good; veils swap a passage for its off-screen version; both replay", () => {
  const src = PACK.replace("@scene bar\nlieu: bar", "@scene bar\nthemes: alcool\nlieu: bar").replace("{amie} te sert un verre.", "{amie} te sert un verre.\n[montré]Elle boit le sien d'un trait.[/montré][voilé]Plus tard, la bouteille est vide.[/voilé]");
  const p = parsePack(src);
  const bar = p.scenes.find((x) => x.id === "bar");
  assert.ok(bar);
  const s = new Story(p, "lines", ["alcool"]);
  for (let i = 0; i < 40 && s.scene; i++) s.choose((s.offers()[0] as { index: number }).index);
  assert.ok(!s.history.includes("bar"));
  assert.match(s.text(bar), /d'un trait/);
  assert.doesNotMatch(s.text(bar), /bouteille/);
  assert.match(s.text(bar, new Set(["alcool"])), /bouteille/);
  const t = new Story(p, "lines2");
  t.choose(0);
  t.setLines(["alcool"]);
  for (let i = 0; i < 40 && t.scene; i++) t.choose((t.offers()[0] as { index: number }).index);
  const r = Story.replay(p, "lines2", t.log);
  assert.deepEqual(r.history, t.history);
  assert.ok(!t.history.slice(2).includes("bar"));
});
