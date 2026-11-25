/**
 * Author's tool. `check` validates a pack (reading and 400 random games); `seal` writes the
 * sealed file a player imports. Usage: node build/kpack.mjs check|seal <pack.txt> [out.kuroko]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PackError, parsePack } from "../story/pack.js";
import { seal } from "../story/seal.js";
import { validate } from "../story/validate.js";

const [cmd, file, out] = process.argv.slice(2);
if (!file || (cmd !== "check" && cmd !== "seal")) {
  console.error("usage: kpack check|seal <pack.txt> [out.kuroko]");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
try {
  const pack = parsePack(text);
  const r = validate(pack);
  console.log(`${pack.title} · ${pack.scenes.length} scènes · ${pack.endings.length} fins · ${pack.personas.length} personnages`);
  for (const e of r.errors) console.log(`ERREUR  ${e}`);
  for (const w of r.warnings) console.log(`avertissement  ${w}`);
  if (r.runs) {
    console.log(`${r.runs} parties simulées · impasses ${r.stuck} · non finies ${r.unfinished} · durée en choix min ${r.beats.min} / médiane ${r.beats.median} / max ${r.beats.max}`);
    console.log(`fins : ${Object.entries(r.endings).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  if (r.errors.length) process.exit(1);
  if (cmd === "seal") {
    const target = out ?? file.replace(/\.[^.]+$/, "") + ".kuroko";
    writeFileSync(target, JSON.stringify(await seal(text, { title: pack.title, age: pack.age, themes: pack.themes })));
    console.log(`scellé : ${target}`);
  }
} catch (e) {
  console.log(e instanceof PackError ? `ERREUR  ${e.message}` : String(e));
  process.exit(1);
}
