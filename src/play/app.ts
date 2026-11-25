/**
 * The reader: a library of packs, a page of story, and the player's own settings.
 * Text from packs is only ever placed with textContent; packs are data, never markup.
 */
import { Rng, seedCode } from "../core/rng.js";
import { clear, h, store } from "../ui/dom.js";
import { PackError, parsePack, type Pack, type Scene } from "../story/pack.js";
import { unseal } from "../story/seal.js";
import { Story } from "../story/story.js";
import { validate } from "../story/validate.js";
import { db, type StoredPack } from "./db.js";

type Level = "montre" | "voile" | "ligne";
interface Settings {
  themes: Record<string, Level>;
  size: number;
  reduced: boolean;
}

const SETTINGS_KEY = "kuroko.reader.v1";
/** The floor we agreed on: these themes can never be shown on screen, only veiled or refused. */
const CAPPED = new Set(["suicide", "automutilation", "violence-sexuelle"]);
const DEFAULTS: Record<string, Level> = { torture: "voile", interrogatoire: "voile", suicide: "voile", automutilation: "voile", "violence-sexuelle": "voile" };
const VIEW_LABEL: Record<string, string> = { proche: "", dossier: "Dossier", miroir: "Miroir" };

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

function paragraphs(text: string): HTMLElement[] {
  return text.split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
    const el = h("p");
    p.split("\n").forEach((line, i) => {
      if (i > 0) el.append(h("br"));
      el.append(...inline(line));
    });
    return el;
  });
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

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
    };
    this.applyLook();
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
    document.documentElement.dataset.size = String(this.settings.size);
    document.documentElement.dataset.motion = this.settings.reduced ? "reduced" : "full";
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
    clear(this.root);
    for (const e of els) this.root.append(e);
    window.scrollTo(0, 0);
  }

  // ======================= Library =======================

  async home(): Promise<void> {
    this.story = null;
    this.packs = (await db.packs()).sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || b.added - a.added);
    const list = h("div", { class: "packs" });
    for (const p of this.packs) {
      const save = await db.save(p.id);
      const going = save && !save.ended;
      const row = h("article", { class: "pack" },
        h("div", { class: "pack-head" },
          h("h2", null, p.title),
          h("p", { class: "meta" }, `${p.age}+`, p.builtin ? " · inclus" : "", p.themes.length ? ` · ${p.themes.map(label).join(", ")}` : ""),
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
    this.mount(
      h("header", { class: "top" },
        h("div", { class: "brand" }, h("span", { class: "kanji", "aria-hidden": "true" }, "黒子"), h("span", null, "KUROKO")),
        h("button", { class: "btn quiet", on: { click: () => this.showSettings() } }, "Réglages"),
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
          this.story = Story.replay(parsed, save.seed, save.log, save.lines);
          this.startLines = [...save.lines];
        } catch {
          this.message = "La partie enregistrée ne se rejoue plus avec cette version du pack. Une nouvelle partie commence.";
          this.story = null;
        }
      }
      if (!this.story) {
        this.startLines = this.lines(parsed.themes);
        this.story = new Story(parsed, freshSeed(), this.startLines);
        await this.persist();
      }
      this.render(false);
    } catch (e) {
      this.message = `Impossible d'ouvrir ce pack : ${e instanceof Error ? e.message : "erreur"}.`;
      await this.home();
    }
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
      ...(s.ending ? { ended: s.ending.id } : {}),
    });
  }

  private choose(index: number): void {
    const s = this.story;
    if (!s || !s.choose(index)) return;
    void this.persist();
    this.render(true);
  }

  private render(animate: boolean): void {
    const s = this.story;
    const p = this.pack;
    if (!s || !p) return;
    const top = h("header", { class: "top" },
      h("button", { class: "btn quiet", on: { click: () => void this.home() } }, "Packs"),
      h("span", { class: "where" }, p.parsed.title),
      h("button", { class: "btn quiet", on: { click: () => this.showSettings() } }, "Réglages"),
    );
    const page = h("main", { class: `page reading${animate && !this.settings.reduced ? " enter" : ""}` });
    if (this.message) {
      page.append(h("p", { class: "message", role: "status" }, this.message));
      this.message = "";
    }
    const last = s.last;
    if (last) {
      const echo = h("div", { class: "echo" }, h("p", { class: "chose" }, last.choice.text));
      if (last.roll) {
        const r = last.roll;
        const word = r.band === "hit" ? "réussite" : r.band === "partial" ? "réussite, à un prix" : "ça tourne mal";
        echo.append(h("p", { class: `roll ${r.band}` }, `2d6 : ${r.dice[0]} + ${r.dice[1]}${r.bonus ? ` ${r.bonus > 0 ? "+" : "−"} ${Math.abs(r.bonus)}` : ""} = ${r.total} · ${word}`));
      }
      page.append(echo);
    }
    if (s.ending) {
      page.append(
        h("article", { class: "ending", tabindex: "-1" },
          h("p", { class: "eyebrow" }, "Fin"),
          h("h1", null, s.ending.title),
          ...paragraphs(s.render(s.ending.text)),
          h("p", { class: "meta" }, `${s.beat} choix · ${new Set(s.history).size} scènes vues`),
          h("div", { class: "row" },
            h("button", { class: "btn primary", on: { click: () => void this.play(p.stored, true) } }, "Nouvelle partie"),
            h("button", { class: "btn quiet", on: { click: () => void this.home() } }, "Packs"),
          ),
        ),
      );
    } else if (s.scene) {
      page.append(this.sceneView(s, s.scene));
    } else {
      page.append(
        h("article", { class: "ending" },
          h("h1", null, "Le récit s'arrête ici"),
          h("p", null, "Aucune scène ne peut suivre et aucune fin n'est écrite pour ce cas. C'est un trou dans le pack, pas une fin : signale-le à son auteur."),
          h("button", { class: "btn", on: { click: () => void this.home() } }, "Packs"),
        ),
      );
    }
    this.mount(top, page);
    (page.querySelector("article") as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private sceneView(s: Story, scene: Scene): HTMLElement {
    const art = h("article", { class: `scene view-${scene.view}`, tabindex: "-1", "aria-label": "Scène" });
    const eyebrow = [VIEW_LABEL[scene.view], scene.place].filter(Boolean).join(" · ");
    if (eyebrow) art.append(h("p", { class: "eyebrow" }, eyebrow));
    art.append(...paragraphs(s.text(scene, this.veils())));
    const choices = h("div", { class: "choices", role: "group", "aria-label": "Choix" });
    for (const o of s.offers()) {
      const b = h("button", { class: "choice", on: { click: () => this.choose(o.index) } }, h("span", { class: "c-text" }, ...inline(s.render(o.choice.text))));
      if (o.odds) {
        b.append(h("span", { class: "c-odds" }, `Jet : ${o.choice.rollLabel} · 10+ ${pct(o.odds.hit)} · 7+ ${pct(o.odds.partial)}`));
      }
      choices.append(b);
    }
    art.append(choices);
    return art;
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
    const back = () => (this.story ? this.render(false) : void this.home());
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
            h("button", { class: "btn", "aria-pressed": String(this.settings.reduced), on: { click: () => { this.settings.reduced = !this.settings.reduced; this.saveSettings(); this.showSettings(); } } }, "Mouvement réduit"),
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
