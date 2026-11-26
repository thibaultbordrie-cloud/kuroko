/**
 * The reader: a library of packs, a character to make, a page of story at night, and the
 * player's own settings. Text from packs is only ever placed with textContent; packs are data.
 */
import { Rng, seedCode } from "../core/rng.js";
import { clear, h, store } from "../ui/dom.js";
import { PackError, parsePack, type Creation, type Option, type Pack, type Scene } from "../story/pack.js";
import { unseal } from "../story/seal.js";
import { Story, heroError, randomHero, type Hero } from "../story/story.js";
import { validate } from "../story/validate.js";
import { Plate, Soundscape, kindOf } from "./ambiance.js";
import { db, type StoredPack } from "./db.js";

type Level = "montre" | "voile" | "ligne";
interface Settings {
  themes: Record<string, Level>;
  size: number;
  reduced: boolean;
  sound: boolean;
  paper: boolean;
}

const SETTINGS_KEY = "kuroko.reader.v1";
/** The floor we agreed on: these themes can never be shown on screen, only veiled or refused. */
const CAPPED = new Set(["suicide", "automutilation", "violence-sexuelle"]);
const DEFAULTS: Record<string, Level> = { torture: "voile", interrogatoire: "voile", suicide: "voile", automutilation: "voile", "violence-sexuelle": "voile" };
const VIEW_LABEL: Record<string, string> = { proche: "", dossier: "Dossier", miroir: "Miroir" };
const NAMES_F = ["Aiko", "Mio", "Rina", "Sayaka", "Yuna", "Léa", "Nora", "Inès", "Maya", "Hana"];
const NAMES_M = ["Ren", "Kaito", "Daichi", "Shun", "Sôta", "Hugo", "Malo", "Elias", "Noé", "Jin"];

function label(theme: string): string {
  const t = theme.replace(/[-_]/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function freshSeed(): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return seedCode(new Rng(`${a[0]}-${a[1]}`));
}

/** A small, safe subset of inline markdown: *italic* and **bold**. */
function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if ((m.index ?? 0) > last) out.push(document.createTextNode(text.slice(last, m.index)));
    out.push(m[1] ? h("strong", null, m[1]) : h("em", null, m[2] ?? ""));
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

const MSG = /^\*\*([^*]+)\*\*\s*(?:\(([^)]{1,30})\))?\s*:\s*(.+)$/;
const LOG = /^\[[^\]]{1,24}\]/;

/**
 * Prose becomes paragraphs; a block where every line is "**Name** : text" becomes a phone
 * thread; a block of "[time] …" lines becomes a terminal; "# Title" becomes a file heading.
 */
function blocks(text: string, me: string): HTMLElement[] {
  return text.split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
    const lines = p.split("\n").filter((l) => l.trim());
    if (lines.length > 0 && lines.every((l) => MSG.test(l.trim()))) {
      const thread = h("div", { class: "phone", role: "log", "aria-label": "Messages" });
      for (const l of lines) {
        const m = MSG.exec(l.trim()) as RegExpExecArray;
        const who = (m[1] as string).trim();
        const mine = /^(toi|moi)$/i.test(who) || (me !== "" && who === me);
        thread.append(h("div", { class: `bubble${mine ? " mine" : ""}` },
          mine ? null : h("span", { class: "who" }, who, m[2] ? h("span", { class: "when" }, ` · ${m[2]}`) : null),
          h("span", null, ...inline(m[3] as string))));
      }
      return thread;
    }
    if (lines.length > 0 && lines.every((l) => LOG.test(l.trim()))) {
      return h("pre", { class: "term" }, lines.map((l) => l.trim()).join("\n"));
    }
    if (lines.length === 1 && /^#\s+/.test(lines[0] as string)) {
      return h("h2", { class: "file-title" }, (lines[0] as string).replace(/^#\s+/, ""));
    }
    if (lines.length === 1 && /^\*\*[^*]+\*\*$/.test((lines[0] as string).trim())) {
      return h("h2", { class: "file-title" }, (lines[0] as string).trim().slice(2, -2));
    }
    const el = h("p");
    p.split("\n").forEach((line, i) => {
      if (i > 0) el.append(h("br"));
      el.append(...inline(line));
    });
    return el;
  });
}

/** Staggers the arrival of each block of a page. */
function stagger(els: HTMLElement[], on: boolean): HTMLElement[] {
  if (on) els.forEach((e, i) => { e.classList.add("arrive"); e.style.setProperty("--i", String(i)); });
  return els;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Preview of creation texts, before a Story exists: gender agreements and the name only. */
function preview(text: string, d: Draft): string {
  return text
    .replace(/\{\?(fem|attire):([^|}]*)\|([^}]*)\}/g, (_, v: string, a: string, b: string) => ((v === "fem" ? d.fem : d.attire) ? a : b))
    .replace(/\{moi\}/g, d.name || "toi")
    .replace(/\{\?[^}]*\}|\{[^}]*\}/g, "");
}

/** Pips on a die face, read left to right, top to bottom on a 3×3 grid. */
const PIPS: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function die(face: number): HTMLElement {
  const d = h("span", { class: "die", "aria-hidden": "true" });
  for (let i = 0; i < 9; i++) d.append(h("i", { class: (PIPS[face] ?? []).includes(i) ? "on" : "" }));
  return d;
}

interface Draft {
  step: number;
  name: string;
  fem: 0 | 1;
  attire: 0 | 1;
  origin: string;
  flaw: string;
  traits: Record<string, number>;
  error: string;
}

export class Player {
  private settings: Settings;
  private packs: StoredPack[] = [];
  private story: Story | null = null;
  private pack: { stored: StoredPack; parsed: Pack } | null = null;
  private pending: { file: StoredPack; text: string } | null = null;
  private confirmDelete: string | null = null;
  private message = "";
  /** The lines in force when this game began: part of the save, so the replay is exact. */
  private startLines: string[] = [];
  private draft: Draft | null = null;
  private plate: Plate | null = null;
  private readonly sound = new Soundscape();

  constructor(private readonly root: HTMLElement, private readonly builtin: readonly string[]) {
    let saved: Partial<Settings> | null = null;
    try {
      saved = JSON.parse(store.get(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    } catch {
      saved = null;
    }
    this.settings = {
      themes: saved?.themes && typeof saved.themes === "object" ? saved.themes : {},
      size: typeof saved?.size === "number" ? Math.max(0, Math.min(3, saved.size)) : 1,
      reduced: typeof saved?.reduced === "boolean" ? saved.reduced : (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
      sound: saved?.sound === true,
      paper: saved?.paper === true,
    };
    this.applyLook();
    // Browsers only let sound start after a gesture: the first touch brings it back.
    if (this.settings.sound) {
      const wake = () => {
        this.sound.enable(this.settings.sound);
        window.removeEventListener("pointerdown", wake);
        window.removeEventListener("keydown", wake);
      };
      window.addEventListener("pointerdown", wake);
      window.addEventListener("keydown", wake);
    }
  }

  async start(): Promise<void> {
    // Built-in packs ship with the app and are always there.
    for (const sealed of this.builtin) {
      try {
        const { meta } = await unseal(sealed);
        await db.putPack({ id: meta.sha256, title: meta.title, age: meta.age, themes: meta.themes, sealed, added: 0, builtin: true });
      } catch {
        /* a broken built-in pack is skipped */
      }
    }
    await this.home();
  }

  private saveSettings(): void {
    store.set(SETTINGS_KEY, JSON.stringify(this.settings));
    this.applyLook();
  }

  private applyLook(): void {
    const d = document.documentElement;
    d.dataset.size = String(this.settings.size);
    d.dataset.motion = this.settings.reduced ? "reduced" : "full";
    d.dataset.theme = this.settings.paper ? "light" : "night";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", this.settings.paper ? "#e9ecef" : "#07080c");
  }

  private level(theme: string): Level {
    const l = this.settings.themes[theme] ?? DEFAULTS[theme] ?? "montre";
    return CAPPED.has(theme) && l === "montre" ? "voile" : l;
  }

  private lines(themes: readonly string[]): string[] {
    return themes.filter((t) => this.level(t) === "ligne").sort();
  }

  private veils(): Set<string> {
    const all = new Set([...Object.keys(this.settings.themes), ...Object.keys(DEFAULTS), ...this.packs.flatMap((p) => p.themes)]);
    return new Set([...all].filter((t) => this.level(t) === "voile"));
  }

  private mount(...els: HTMLElement[]): void {
    this.plate?.stop();
    this.plate = null;
    clear(this.root);
    for (const e of els) this.root.append(e);
    window.scrollTo(0, 0);
  }

  /** A painted, living plate at the top of a page. */
  private paint(canvas: HTMLCanvasElement, place: string, mood: string, seed: string, cold: boolean): void {
    const kind = kindOf(place, mood);
    this.plate = new Plate(canvas, kind, seed, this.settings.reduced, cold);
    this.sound.set(kind);
  }

  private soundButton(): HTMLElement {
    return h("button", {
      class: "btn quiet sound",
      "aria-pressed": String(this.settings.sound),
      "aria-label": this.settings.sound ? "Couper le son" : "Mettre le son",
      on: {
        click: (e: Event) => {
          this.settings.sound = !this.settings.sound;
          this.saveSettings();
          this.sound.enable(this.settings.sound);
          const b = e.currentTarget as HTMLElement;
          b.setAttribute("aria-pressed", String(this.settings.sound));
          b.setAttribute("aria-label", this.settings.sound ? "Couper le son" : "Mettre le son");
          b.textContent = this.settings.sound ? "Son ●" : "Son ○";
        },
      },
    }, this.settings.sound ? "Son ●" : "Son ○");
  }

  // ======================= Library =======================

  async home(): Promise<void> {
    this.story = null;
    this.draft = null;
    this.packs = (await db.packs()).sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || b.added - a.added);
    const list = h("div", { class: "packs" });
    for (const p of this.packs) {
      const save = await db.save(p.id);
      const going = save && !save.ended;
      const row = h("article", { class: `pack${p.age >= 18 ? " adult" : ""}` },
        h("div", { class: "pack-head" },
          h("h2", null, p.title),
          h("p", { class: "meta" }, `${p.age}+`, p.builtin ? " · inclus" : "", going && save?.hero ? ` · partie de ${save.hero.name} en cours` : going ? " · partie en cours" : ""),
        ),
        h("div", { class: "row" },
          going ? h("button", { class: "btn primary", on: { click: () => void this.play(p, false) } }, "Continuer") : null,
          h("button", { class: going ? "btn" : "btn primary", on: { click: () => void this.play(p, true) } }, going ? "Recommencer" : "Nouvelle partie"),
          p.builtin ? null : h("button", { class: "btn quiet", on: { click: () => { this.confirmDelete = p.id; void this.home(); } } }, "Supprimer"),
        ),
      );
      if (this.confirmDelete === p.id) {
        row.append(
          h("div", { class: "confirm", role: "group" },
            h("p", null, "Supprimer ce pack et sa partie de cet appareil ?"),
            h("button", { class: "btn danger", on: { click: () => void db.deletePack(p.id).then(() => { this.confirmDelete = null; return this.home(); }) } }, "Supprimer"),
            h("button", { class: "btn quiet", on: { click: () => { this.confirmDelete = null; void this.home(); } } }, "Garder"),
          ),
        );
      }
      list.append(row);
    }
    if (this.packs.length === 0) list.append(h("p", { class: "meta" }, "Aucun pack pour l'instant. Importe un fichier .kuroko."));

    const input = h("input", { type: "file", id: "import", accept: ".kuroko,application/json", class: "sr" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (f) void this.importFile(f);
    });
    const gate = this.pending
      ? h("div", { class: "confirm gate", role: "group", "aria-labelledby": "gate-title" },
          h("h2", { id: "gate-title" }, this.pending.file.title),
          h("p", null, `Réservé aux ${this.pending.file.age} ans et plus.`),
          this.pending.file.themes.length ? h("p", { class: "meta" }, `Thèmes : ${this.pending.file.themes.map(label).join(", ")}`) : null,
          h("p", null, "Tes réglages de lignes et voiles s'appliqueront à ce pack."),
          h("div", { class: "row" },
            h("button", { class: "btn primary", on: { click: () => void this.acceptPending() } }, `J'ai ${this.pending.file.age} ans ou plus`),
            h("button", { class: "btn quiet", on: { click: () => { this.pending = null; void this.home(); } } }, "Annuler"),
          ),
        )
      : null;
    const msg = this.message ? h("p", { class: "message", role: "status" }, this.message) : null;
    this.message = "";
    const canvas = h("canvas", { class: "plate-canvas", "aria-hidden": "true" });
    this.mount(
      h("header", { class: "top" },
        h("div", { class: "brand" }, h("span", { class: "kanji", "aria-hidden": "true" }, "黒子"), h("span", null, "KUROKO")),
        h("div", { class: "row tight" }, this.soundButton(), h("button", { class: "btn quiet", on: { click: () => this.showSettings() } }, "Réglages")),
      ),
      h("div", { class: "hero-plate" },
        canvas,
        h("div", { class: "hero-text" },
          h("p", { class: "kanji-big", "aria-hidden": "true" }, "黒子"),
          h("p", { class: "tagline" }, "Celui qu'on ne voit pas sur scène."),
        ),
      ),
      h("main", { class: "page" },
        msg,
        gate,
        h("section", null, h("h1", { class: "eyebrow" }, "Tes packs"), list),
        h("section", { class: "import" },
          h("label", { class: "btn", for: "import" }, "Importer un pack"),
          input,
          h("p", { class: "meta" }, "Le fichier reste sur cet appareil. Il n'est jamais envoyé nulle part."),
        ),
      ),
    );
    this.paint(canvas, "rue", "rue", "home", false);
  }

  private async importFile(f: File): Promise<void> {
    try {
      if (f.size > 8_000_000) throw new Error("fichier trop volumineux pour un pack");
      const text = await f.text();
      const { meta, text: source } = await unseal(text);
      const parsed = parsePack(source);
      // Checked quietly: the player learns that it works, never what is inside.
      const r = validate(parsed, 60, 600);
      if (r.errors.length) throw new Error(`ce pack contient ${r.errors.length} erreur(s) ; son auteur doit le corriger`);
      const file: StoredPack = { id: meta.sha256, title: parsed.title, age: parsed.age, themes: parsed.themes, sealed: text, added: Date.now() };
      if (file.age >= 18) {
        this.pending = { file, text };
        await this.home();
        return;
      }
      await db.putPack(file);
      this.message = `« ${file.title} » est prêt.`;
    } catch (e) {
      this.message = `Import refusé : ${e instanceof PackError ? "le texte du pack est mal formé" : e instanceof Error ? e.message : "fichier illisible"}.`;
    }
    await this.home();
  }

  private async acceptPending(): Promise<void> {
    const p = this.pending;
    this.pending = null;
    if (p) {
      const ok = await db.putPack(p.file);
      this.message = ok ? `« ${p.file.title} » est prêt.` : "Ce navigateur refuse de garder le pack (navigation privée ?).";
    }
    await this.home();
  }

  // ======================= Reading =======================

  private async play(p: StoredPack, fresh: boolean): Promise<void> {
    this.story = null;
    try {
      const { text } = await unseal(p.sealed);
      const parsed = parsePack(text);
      this.pack = { stored: p, parsed };
      const save = fresh ? null : await db.save(p.id);
      if (save && !save.ended) {
        try {
          this.story = Story.replay(parsed, save.seed, save.log, save.lines, save.hero ?? null);
          this.startLines = [...save.lines];
        } catch {
          this.message = "La partie enregistrée ne se rejoue plus avec cette version du pack. Une nouvelle partie commence.";
          this.story = null;
        }
      }
      if (!this.story) {
        if (parsed.creation) {
          this.create(parsed.creation);
          return;
        }
        await this.begin(null);
        return;
      }
      this.render(false);
    } catch (e) {
      this.message = `Impossible d'ouvrir ce pack : ${e instanceof Error ? e.message : "erreur"}.`;
      await this.home();
    }
  }

  private async begin(hero: Hero | null): Promise<void> {
    const p = this.pack;
    if (!p) return;
    this.startLines = this.lines(p.parsed.themes);
    this.story = new Story(p.parsed, freshSeed(), this.startLines, hero);
    this.draft = null;
    await this.persist();
    this.render(true);
  }

  private async persist(): Promise<void> {
    const s = this.story;
    const p = this.pack;
    if (!s || !p) return;
    await db.putSave({
      pack: p.stored.id,
      seed: s.seed,
      lines: this.startLines,
      log: s.log.slice(),
      updated: Date.now(),
      ...(s.hero ? { hero: s.hero } : {}),
      ...(s.ending ? { ended: s.ending.id } : {}),
    });
  }

  private choose(index: number): void {
    const s = this.story;
    if (!s || !s.choose(index)) return;
    void this.persist();
    this.render(true);
  }

  private topBar(): HTMLElement {
    const p = this.pack;
    const s = this.story;
    return h("header", { class: "top" },
      h("button", { class: "btn quiet", on: { click: () => void this.home() } }, "Packs"),
      h("span", { class: "where" }, p?.parsed.title ?? ""),
      h("div", { class: "row tight" },
        this.soundButton(),
        s?.hero ? h("button", { class: "btn quiet", on: { click: () => this.showSheet() } }, "Toi") : null,
        h("button", { class: "btn quiet", on: { click: () => this.showSettings() } }, "Réglages"),
      ),
    );
  }

  private render(animate: boolean): void {
    const s = this.story;
    const p = this.pack;
    if (!s || !p) return;
    const motion = animate && !this.settings.reduced;
    const page = h("main", { class: "page reading" });
    if (this.message) {
      page.append(h("p", { class: "message", role: "status" }, this.message));
      this.message = "";
    }
    const last = s.last;
    let dice: HTMLElement | null = null;
    if (last) {
      const echo = h("div", { class: "echo" }, h("p", { class: "chose" }, s.render(last.choice.text)));
      if (last.roll) {
        const r = last.roll;
        const word = r.band === "hit" ? "Réussite" : r.band === "partial" ? "Réussite, à un prix" : "Ça tourne mal";
        dice = h("div", { class: `dice ${r.band}` }, die(r.dice[0]), die(r.dice[1]),
          h("span", { class: "roll" }, `${r.bonus ? `${r.bonus > 0 ? "+" : "−"}${Math.abs(r.bonus)} ` : ""}= ${r.total}`),
          h("span", { class: "verdict" }, word));
        dice.setAttribute("role", "img");
        dice.setAttribute("aria-label", `Deux dés : ${r.dice[0]} et ${r.dice[1]}, total ${r.total}. ${word}.`);
        echo.append(dice);
      }
      page.append(echo);
    }
    let canvas: HTMLCanvasElement | null = null;
    let scene: Scene | null = null;
    if (s.ending) {
      canvas = h("canvas", { class: "plate-canvas", "aria-hidden": "true" });
      page.append(
        h("article", { class: "ending", tabindex: "-1" },
          h("div", { class: "plate" }, canvas, h("p", { class: "plate-label" }, "Fin")),
          h("h1", null, s.render(s.ending.title)),
          ...stagger(blocks(s.render(s.ending.text), s.hero?.name ?? ""), motion),
          h("p", { class: "meta" }, `${s.beat} choix · ${new Set(s.history).size} scènes vues`),
          h("div", { class: "row" },
            h("button", { class: "btn primary", on: { click: () => void this.play(p.stored, true) } }, "Nouvelle partie"),
            h("button", { class: "btn quiet", on: { click: () => void this.home() } }, "Packs"),
          ),
        ),
      );
    } else if (s.scene) {
      scene = s.scene;
      canvas = h("canvas", { class: "plate-canvas", "aria-hidden": "true" });
      page.append(this.sceneView(s, s.scene, canvas, motion));
    } else {
      page.append(
        h("article", { class: "ending" },
          h("h1", null, "Le récit s'arrête ici"),
          h("p", null, "Aucune scène ne peut suivre et aucune fin n'est écrite pour ce cas. C'est un trou dans le pack, pas une fin : signale-le à son auteur."),
          h("button", { class: "btn", on: { click: () => void this.home() } }, "Packs"),
        ),
      );
    }
    this.mount(this.topBar(), page);
    if (canvas) {
      if (scene) this.paint(canvas, scene.place, scene.mood, `${s.seed}/${scene.id}`, scene.view === "miroir");
      else this.paint(canvas, "rue", "riviere", `${s.seed}/fin`, true);
    }
    if (dice && motion) this.tumble(dice, last?.roll?.dice ?? [1, 1]);
    (page.querySelector("article") as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** The dice roll on screen for a moment, then land on what the story already decided. */
  private tumble(el: HTMLElement, faces: readonly [number, number]): void {
    el.classList.add("rolling");
    const dies = Array.from(el.querySelectorAll<HTMLElement>(".die"));
    let n = 0;
    const id = window.setInterval(() => {
      n++;
      const done = n >= 9;
      dies.forEach((d, i) => {
        const f = done ? (faces[i] ?? 1) : 1 + Math.floor(Math.random() * 6);
        d.replaceWith(die(f));
      });
      dies.splice(0, dies.length, ...Array.from(el.querySelectorAll<HTMLElement>(".die")));
      if (done) {
        window.clearInterval(id);
        el.classList.remove("rolling");
        el.classList.add("landed");
      }
    }, 70);
  }

  private sceneView(s: Story, scene: Scene, canvas: HTMLCanvasElement, motion: boolean): HTMLElement {
    const art = h("article", { class: `scene view-${scene.view}`, tabindex: "-1", "aria-label": "Scène" });
    const eyebrow = [VIEW_LABEL[scene.view], scene.place].filter(Boolean).join(" · ");
    art.append(h("div", { class: "plate" }, canvas, eyebrow ? h("p", { class: "plate-label" }, eyebrow) : null));
    const body = blocks(s.text(scene, this.veils()), s.hero?.name ?? "");
    if (scene.view === "dossier") {
      art.append(h("div", { class: "file" }, h("span", { class: "stamp", "aria-hidden": "true" }, "機密"), ...stagger(body, motion)));
    } else {
      art.append(...stagger(body, motion));
    }
    const choices = h("div", { class: "choices", role: "group", "aria-label": "Choix" });
    const offers = s.offers();
    offers.forEach((o, i) => {
      const b = h("button", { class: `choice${o.odds ? " risky" : ""}`, on: { click: () => this.choose(o.index) } },
        h("span", { class: "c-num", "aria-hidden": "true" }, String(i + 1)),
        h("span", { class: "c-text" }, ...inline(s.render(o.choice.text))));
      if (o.odds) {
        const bar = h("span", { class: "odds-bar", "aria-hidden": "true" }, h("i", { class: "hit" }), h("i", { class: "part" }));
        (bar.children[0] as HTMLElement).style.setProperty("width", pct(o.odds.hit).replace(" ", ""));
        (bar.children[1] as HTMLElement).style.setProperty("width", pct(o.odds.partial - o.odds.hit).replace(" ", ""));
        b.append(h("span", { class: "c-odds" }, bar, h("span", null, `${o.choice.rollLabel || "Jet"} · net ${pct(o.odds.hit)} · en tout ${pct(o.odds.partial)}`)));
      }
      choices.append(b);
    });
    if (motion) {
      choices.classList.add("arrive");
      choices.style.setProperty("--i", String(Math.min(body.length, 8)));
    }
    art.append(choices);
    return art;
  }

  // ======================= Character =======================

  private create(c: Creation): void {
    if (!this.draft) {
      this.draft = { step: 0, name: "", fem: 1, attire: 0, origin: "", flaw: "", traits: Object.fromEntries(c.traits.map((t) => [t, 0])), error: "" };
    }
    const d = this.draft;
    const steps = ["Qui", "D'où", "Talents", "Faille", "Toi"];
    const progress = h("ol", { class: "steps", "aria-label": "Étapes" },
      ...steps.map((t, i) => h("li", { class: i === d.step ? "now" : i < d.step ? "done" : "", "aria-current": i === d.step ? "step" : null }, t)));
    const canvas = h("canvas", { class: "plate-canvas", "aria-hidden": "true" });
    const body = h("section", { class: "create" });
    const used = c.traits.reduce((a, t) => a + (d.traits[t] ?? 0), 0);
    const go = (step: number) => {
      d.step = step;
      d.error = "";
      this.create(c);
    };
    const next = (ok: boolean, why: string) => h("button", {
      class: "btn primary",
      on: { click: () => { if (ok) go(d.step + 1); else { d.error = why; this.create(c); } } },
    }, "Suivant");
    const back = d.step > 0 ? h("button", { class: "btn quiet", on: { click: () => go(d.step - 1) } }, "Retour") : null;

    switch (d.step) {
      case 0: {
        const input = h("input", { id: "hero-name", class: "field", type: "text", maxlength: "24", autocomplete: "off", spellcheck: "false", value: d.name, placeholder: "Ton prénom" }) as HTMLInputElement;
        input.addEventListener("input", () => { d.name = input.value; });
        const seg = (title: string, cur: 0 | 1, a: string, b: string, set: (v: 0 | 1) => void) =>
          h("div", { class: "pick" }, h("span", { class: "pick-label" }, title),
            h("div", { class: "seg", role: "radiogroup", "aria-label": title },
              h("button", { class: "seg-btn", role: "radio", "aria-checked": String(cur === 1), on: { click: () => { set(1); this.create(c); } } }, a),
              h("button", { class: "seg-btn", role: "radio", "aria-checked": String(cur === 0), on: { click: () => { set(0); this.create(c); } } }, b)));
        body.append(
          h("h1", { class: "title" }, "Qui es-tu, cette nuit ?"),
          h("label", { class: "pick-label", for: "hero-name" }, "Prénom"),
          h("div", { class: "row" }, input, h("button", { class: "btn", on: { click: () => { const pool = d.fem ? NAMES_F : NAMES_M; d.name = pool[Math.floor(Math.random() * pool.length)] as string; this.create(c); } } }, "Au hasard")),
          seg("Tu es", d.fem, "une femme", "un homme", (v) => { d.fem = v; }),
          seg("Tu es attiré" + (d.fem ? "e" : "") + " par", d.attire, "les femmes", "les hommes", (v) => { d.attire = v; }),
          h("p", { class: "meta" }, "Ces choix changent le texte, les accords et certaines personnes que tu croiseras."),
        );
        body.append(h("div", { class: "row" },
          h("button", { class: "btn primary", on: { click: () => { d.name = (input.value || "").trim(); if (/^[\p{L}][\p{L}' -]{0,23}$/u.test(d.name)) go(1); else { d.error = "Un prénom : des lettres, et au plus 24."; this.create(c); } } } }, "Suivant"),
          h("button", { class: "btn quiet", on: { click: () => this.randomize(c) } }, "Tout au hasard"),
        ));
        break;
      }
      case 1:
      case 3: {
        const flaw = d.step === 3;
        const list = flaw ? c.flaws : c.origins;
        const cur = flaw ? d.flaw : d.origin;
        body.append(h("h1", { class: "title" }, flaw ? "Ce qui te perdra" : "D'où tu viens"));
        if (flaw) body.append(h("p", { class: "meta" }, "Une faille ouvre des portes que la prudence garde fermées. Elle coûte, aussi."));
        const cards = h("div", { class: "cards", role: "radiogroup", "aria-label": flaw ? "Faille" : "Origine" });
        for (const o of list) cards.append(this.optionCard(o, cur === o.id, d, () => { if (flaw) d.flaw = o.id; else d.origin = o.id; d.error = ""; this.create(c); }));
        body.append(cards, h("div", { class: "row" }, back, next(cur !== "", flaw ? "Choisis une faille." : "Choisis une origine.")));
        break;
      }
      case 2: {
        body.append(h("h1", { class: "title" }, "Ce que tu sais faire"),
          h("p", { class: "meta" }, `Répartis ${c.points} points, ${c.max} au plus par talent. Chaque point s'ajoute aux dés quand ce talent est en jeu.`),
          h("p", { class: `left${used === c.points ? " full" : ""}`, role: "status" }, `${c.points - used} point${c.points - used > 1 ? "s" : ""} à placer`));
        const grid = h("div", { class: "traits" });
        for (const t of c.traits) {
          const v = d.traits[t] ?? 0;
          const about = c.about.find((a) => a.id === t);
          const pips = h("span", { class: "pips", "aria-hidden": "true" }, ...Array.from({ length: c.max }, (_, i) => h("i", { class: i < v ? "on" : "" })));
          grid.append(h("div", { class: "trait" },
            h("div", { class: "trait-head" },
              h("span", { class: "trait-name" }, about?.title ?? label(t)),
              h("div", { class: "stepper" },
                h("button", { class: "btn round", "aria-label": `Retirer un point à ${about?.title ?? t}`, disabled: v <= 0, on: { click: () => { d.traits[t] = v - 1; this.create(c); } } }, "−"),
                pips,
                h("span", { class: "sr" }, String(v)),
                h("button", { class: "btn round", "aria-label": `Ajouter un point à ${about?.title ?? t}`, disabled: v >= c.max || used >= c.points, on: { click: () => { d.traits[t] = v + 1; this.create(c); } } }, "+"),
              )),
            about?.text ? h("p", { class: "meta" }, preview(about.text, d)) : null));
        }
        body.append(grid, h("div", { class: "row" }, back, next(used === c.points, `Il reste ${c.points - used} point(s) à placer.`)));
        break;
      }
      default: {
        const hero = this.heroOf(d);
        const err = this.pack ? heroError(this.pack.parsed, hero) : null;
        const origin = c.origins.find((o) => o.id === d.origin);
        const flaw = c.flaws.find((o) => o.id === d.flaw);
        body.append(h("h1", { class: "title" }, "Ton dossier"), this.sheet(c, hero, origin, flaw));
        if (err) body.append(h("p", { class: "message", role: "alert" }, err));
        body.append(
          h("div", { class: "row" }, back, h("button", { class: "btn primary big", disabled: !!err, on: { click: () => void this.begin(hero) } }, "Entrer dans la nuit")));
      }
    }
    if (d.error) body.prepend(h("p", { class: "message", role: "alert" }, d.error));
    this.mount(
      h("header", { class: "top" },
        h("button", { class: "btn quiet", on: { click: () => void this.home() } }, "Packs"),
        h("span", { class: "where" }, this.pack?.parsed.title ?? ""),
        this.soundButton(),
      ),
      h("div", { class: "plate slim" }, canvas, h("p", { class: "plate-label" }, "Création")),
      h("main", { class: "page" }, progress, body),
    );
    this.paint(canvas, "", "chambre", `creation/${d.step}`, d.step === 3);
    (body.querySelector(".title") as HTMLElement | null)?.setAttribute("tabindex", "-1");
    (body.querySelector(".title") as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private optionCard(o: Option, on: boolean, d: Draft, pick: () => void): HTMLElement {
    return h("button", { class: `card${on ? " on" : ""}`, role: "radio", "aria-checked": String(on), on: { click: pick } },
      h("span", { class: "card-title" }, preview(o.title, d)),
      o.text ? h("span", { class: "card-text" }, preview(o.text, d)) : null);
  }

  private heroOf(d: Draft): Hero {
    return { name: d.name.trim(), fem: d.fem, attire: d.attire, origin: d.origin, flaw: d.flaw, traits: { ...d.traits } };
  }

  private randomize(c: Creation): void {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    const rng = new Rng(`hero-${a[0]}`);
    const r = this.pack ? randomHero(this.pack.parsed, rng) : null;
    if (!r) return;
    const pool = r.fem ? NAMES_F : NAMES_M;
    this.draft = { step: 4, name: rng.pick(pool), fem: r.fem, attire: r.attire, origin: r.origin, flaw: r.flaw, traits: { ...r.traits }, error: "" };
    this.create(c);
  }

  /** The character as a file: name, origin, flaw, talents. */
  private sheet(c: Creation, hero: Hero, origin: Option | undefined, flaw: Option | undefined): HTMLElement {
    const d: Draft = { step: 0, name: hero.name, fem: hero.fem, attire: hero.attire, origin: hero.origin, flaw: hero.flaw, traits: { ...hero.traits }, error: "" };
    return h("div", { class: "file sheet" },
      h("span", { class: "stamp", "aria-hidden": "true" }, "黒子"),
      h("p", { class: "sheet-name" }, hero.name),
      h("p", { class: "meta" }, `${hero.fem ? "Femme" : "Homme"} · attiré${hero.fem ? "e" : ""} par ${hero.attire ? "les femmes" : "les hommes"}`),
      h("dl", { class: "sheet-list" },
        h("dt", null, "Origine"), h("dd", null, origin ? preview(origin.title, d) : "—"),
        h("dt", null, "Faille"), h("dd", null, flaw ? preview(flaw.title, d) : "—"),
      ),
      h("div", { class: "traits compact" },
        ...c.traits.map((t) => {
          const v = hero.traits[t] ?? 0;
          const about = c.about.find((a) => a.id === t);
          return h("div", { class: "trait-head" },
            h("span", { class: "trait-name" }, about?.title ?? label(t)),
            h("span", { class: "pips", role: "img", "aria-label": `${v} sur ${c.max}` }, ...Array.from({ length: c.max }, (_, i) => h("i", { class: i < v ? "on" : "" }))));
        })),
    );
  }

  private showSheet(): void {
    const s = this.story;
    const c = this.pack?.parsed.creation;
    if (!s?.hero || !c) return;
    const hero = s.hero;
    this.mount(
      h("header", { class: "top" },
        h("button", { class: "btn quiet", on: { click: () => this.render(false) } }, "Retour"),
        h("span", { class: "where" }, "Toi"),
        h("span"),
      ),
      h("main", { class: "page" },
        this.sheet(c, hero, c.origins.find((o) => o.id === hero.origin), c.flaws.find((o) => o.id === hero.flaw)),
        h("p", { class: "meta" }, `${s.beat} choix faits · ${new Set(s.history).size} scènes vues`),
      ),
    );
  }

  // ======================= Settings =======================

  private showSettings(): void {
    const themes = [...new Set([...this.packs.flatMap((p) => p.themes), ...Object.keys(DEFAULTS)])].sort();
    const rows = h("div", { class: "themes" });
    for (const t of themes) {
      const cur = this.level(t);
      const group = h("div", { class: "seg", role: "radiogroup", "aria-label": label(t) });
      for (const [v, name] of [["montre", "Montré"], ["voile", "Voilé"], ["ligne", "Ligne"]] as const) {
        const disabled = v === "montre" && CAPPED.has(t);
        group.append(
          h("button", { class: "seg-btn", role: "radio", "aria-checked": String(cur === v), disabled, on: { click: () => this.setTheme(t, v) } }, name),
        );
      }
      rows.append(h("div", { class: "theme" }, h("span", null, label(t)), group));
    }
    const back = () => (this.story ? this.render(false) : this.draft && this.pack?.parsed.creation ? this.create(this.pack.parsed.creation) : void this.home());
    const toggle = (name: string, on: boolean, flip: () => void) =>
      h("button", { class: "btn", "aria-pressed": String(on), on: { click: () => { flip(); this.saveSettings(); this.showSettings(); } } }, name);
    this.mount(
      h("header", { class: "top" },
        h("button", { class: "btn quiet", on: { click: back } }, "Retour"),
        h("span", { class: "where" }, "Réglages"),
        h("span"),
      ),
      h("main", { class: "page" },
        h("section", null,
          h("h1", { class: "eyebrow" }, "Lignes et voiles"),
          h("p", { class: "meta" }, "Montré : écrit en scène. Voilé : ça arrive hors champ. Ligne : n'arrive jamais. Les changements valent dès la scène suivante, sans rien dévoiler."),
          rows,
        ),
        h("section", null,
          h("h1", { class: "eyebrow" }, "Lecture"),
          h("div", { class: "row" },
            h("button", { class: "btn", disabled: this.settings.size <= 0, on: { click: () => { this.settings.size--; this.saveSettings(); this.showSettings(); } } }, "Texte plus petit"),
            h("button", { class: "btn", disabled: this.settings.size >= 3, on: { click: () => { this.settings.size++; this.saveSettings(); this.showSettings(); } } }, "Texte plus grand"),
            toggle("Mouvement réduit", this.settings.reduced, () => { this.settings.reduced = !this.settings.reduced; }),
            toggle("Page claire", this.settings.paper, () => { this.settings.paper = !this.settings.paper; }),
          ),
        ),
      ),
    );
  }

  private setTheme(theme: string, v: Level): void {
    if (v === "montre" && CAPPED.has(theme)) return;
    this.settings.themes[theme] = v;
    this.saveSettings();
    const s = this.story;
    if (s && this.pack) {
      const lines = this.lines(this.pack.parsed.themes);
      s.setLines(lines);
      void this.persist();
    }
    this.showSettings();
  }
}
