/**
 * The game's screens: title, network, mission, debrief. All state lives in the core classes;
 * this file turns input into actions and actions into pictures, sounds and words.
 */
import { Campaign, HEAT_LIMIT, INTEL_GOAL, WEEKS, type AgentCard, type Decision, type Op, type Report } from "../core/campaign.js";
import { generate } from "../core/gen.js";
import { ghostAction } from "../core/ghost.js";
import { DIRS, dirTo, eq, type Dir, type Pt } from "../core/map.js";
import { DAWN, Mission, type Action, type Agent, type Event, type Outcome } from "../core/mission.js";
import { CITIES, person, type City } from "../core/names.js";
import { Rng, seedCode } from "../core/rng.js";
import { path } from "../core/senses.js";
import type { MissionDef, Site } from "../core/types.js";
import { Audio, type Sfx } from "./audio.js";
import { append, clear, h, store } from "./dom.js";
import { CITY, COVER, SITE, outcomeKey, t, type Key, type Lang } from "./i18n.js";
import { Renderer } from "./render.js";

const SAVE_KEY = "kuroko.save.v1";
const SETTINGS_KEY = "kuroko.settings.v1";
const SITES: readonly Site[] = ["datacenter", "consulate", "biolab", "port", "tower", "studio"];
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;

interface Settings {
  lang: Lang;
  sound: boolean;
  reduced: boolean;
}

interface SaveData {
  v: 1;
  seed: string;
  decisions: Decision[];
  current: { op: number; agent: number; log: Action[] } | null;
}

type Ctx = { kind: "campaign"; op: Op; agent: AgentCard } | { kind: "quick"; code: string; city: City };

const GOOD: readonly Outcome[] = ["ghost", "quiet"];
const MID: readonly Outcome[] = ["loud", "burned", "aborted", "dawn"];

// ---------- Validation of anything read back from storage ----------

function isInt(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

function validAction(a: unknown): a is Action {
  if (!a || typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  switch (o.t) {
    case "step":
    case "run":
      return isInt(o.d, 0, 7);
    case "throw": {
      const p = o.at as Record<string, unknown> | undefined;
      return !!p && isInt(p.x, 0, 200) && isInt(p.y, 0, 200);
    }
    case "wait":
    case "pick":
    case "use":
    case "leave":
    case "bluff":
    case "flee":
      return true;
    default:
      return false;
  }
}

function validDecision(d: unknown): d is Decision {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  switch (o.t) {
    case "mission":
      return isInt(o.op, 0, 10_000) && isInt(o.agent, 0, 10) && Array.isArray(o.log) && o.log.length <= 5000 && o.log.every(validAction);
    case "confront":
      return isInt(o.agent, 0, 10);
    case "lowkey":
    case "canary":
      return true;
    default:
      return false;
  }
}

function parseSave(raw: string | null): SaveData | null {
  if (!raw || raw.length > 2_000_000) return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d.v !== 1 || typeof d.seed !== "string" || !CODE.test(d.seed)) return null;
    if (!Array.isArray(d.decisions) || d.decisions.length > 200 || !d.decisions.every(validDecision)) return null;
    let current: SaveData["current"] = null;
    const c = d.current as Record<string, unknown> | null | undefined;
    if (c) {
      if (!isInt(c.op, 0, 10_000) || !isInt(c.agent, 0, 10) || !Array.isArray(c.log) || c.log.length > 5000 || !c.log.every(validAction)) return null;
      current = { op: c.op, agent: c.agent, log: c.log };
    }
    return { v: 1, seed: d.seed, decisions: d.decisions, current };
  } catch {
    return null;
  }
}

function freshCode(): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return seedCode(new Rng(`${a[0]}-${a[1]}`));
}


// ---------- The app ----------

export class App {
  private readonly root: HTMLElement;
  private settings: Settings;
  private readonly audio = new Audio();
  private campaign: Campaign | null = null;
  private renderer: Renderer | null = null;
  private screen: "title" | "network" | "mission" | "debrief" = "title";
  private notice = "";

  // Network screen state.
  private selectedOp: number | null = null;
  private confirmAgent: number | null = null;
  private confirmNew = false;

  // Mission state.
  private mission: Mission | null = null;
  private ctx: Ctx | null = null;
  private runMode = false;
  private plan = false;
  private lure: Pt | null = null;
  private walk: Pt[] = [];
  private walkTimer = 0;
  private lastKey = 0;
  private logLines: { text: string; bad: boolean }[] = [];
  private els: { hud: HTMLElement; actions: HTMLElement; log: HTMLElement; hint: HTMLElement; modal: HTMLElement } | null = null;

  // Title demo.
  private demo: Mission | null = null;
  private demoTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    const saved = (() => {
      try {
        return JSON.parse(store.get(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
      } catch {
        return null;
      }
    })();
    const reducedOs = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.settings = {
      lang: saved?.lang === "en" || saved?.lang === "fr" ? saved.lang : navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en",
      sound: false,
      reduced: typeof saved?.reduced === "boolean" ? saved.reduced : reducedOs,
    };
    document.documentElement.lang = this.settings.lang;
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("resize", () => this.renderer?.resize());
    const loop = (now: number) => {
      this.renderer?.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.addEventListener("hashchange", () => this.fromHash());
  }

  start(): void {
    if (!this.fromHash()) this.showTitle();
  }

  private tr(key: Key, vars?: Record<string, string | number>): string {
    return t(this.settings.lang, key, vars);
  }

  private saveSettings(): void {
    store.set(SETTINGS_KEY, JSON.stringify({ lang: this.settings.lang, reduced: this.settings.reduced }));
  }

  private save(): void {
    const c = this.campaign;
    if (!c) return;
    const current = this.mission && this.ctx?.kind === "campaign" && this.mission.status !== "done" ? { op: this.ctx.op.id, agent: this.ctx.agent.id, log: this.mission.log.slice() } : null;
    const data: SaveData = { v: 1, seed: c.seed, decisions: c.decisions.slice(), current };
    store.set(SAVE_KEY, JSON.stringify(data));
  }

  private fromHash(): boolean {
    const m = /^#mission-([A-HJ-NP-Z2-9]{8})$/.exec(location.hash);
    if (!m || !m[1]) return false;
    if (this.mission && this.ctx?.kind === "quick" && this.ctx.code === m[1] && this.screen === "mission") return true;
    this.quick(m[1]);
    return true;
  }

  private mount(...children: HTMLElement[]): void {
    this.stopDemo();
    this.stopWalk();
    clear(this.root);
    this.renderer = null;
    this.els = null;
    for (const c of children) this.root.append(c);
  }

  // ======================= Title =======================

  private showTitle(): void {
    this.screen = "title";
    this.mission = null;
    const saved = parseSave(store.get(SAVE_KEY));
    const canvas = h("canvas", { role: "img", "aria-label": this.tr("demo") });
    const lang = this.settings.lang;
    const menu = h("div", { class: "menu" });
    if (saved) {
      menu.append(
        h("button", { class: "btn primary", on: { click: () => this.loadCampaign(saved) } }, this.tr("continue"), h("small", null, `${this.tr("week")} ${Math.min(WEEKS, 1 + saved.decisions.filter((d) => d.t !== "confront").length)}`)),
      );
    }
    if (this.confirmNew && saved) {
      menu.append(
        h("div", { class: "confirm", role: "group" },
          h("p", null, this.tr("overwrite")),
          h("button", { class: "btn danger", on: { click: () => this.newCampaign() } }, this.tr("yes")),
          h("button", { class: "btn ghost", on: { click: () => { this.confirmNew = false; this.showTitle(); } } }, this.tr("no")),
        ),
      );
    } else {
      menu.append(h("button", { class: saved ? "btn" : "btn primary", on: { click: () => (saved ? ((this.confirmNew = true), this.showTitle()) : this.newCampaign()) } }, this.tr("newGame")));
    }
    menu.append(h("button", { class: "btn", on: { click: () => this.quick(freshCode()) } }, this.tr("quick"), h("small", null, "#")));
    const settings = h("div", { class: "settings" },
      h("button", { class: "btn ghost", lang: lang === "fr" ? "en" : "fr", on: { click: () => this.setLang(lang === "fr" ? "en" : "fr") } }, this.tr("language")),
      h("button", { class: "btn ghost", "aria-pressed": String(this.settings.sound), on: { click: () => this.toggleSound() } }, `${this.tr("sound")} : ${this.tr(this.settings.sound ? "on" : "off")}`),
      h("button", { class: "btn ghost", "aria-pressed": String(this.settings.reduced), on: { click: () => this.toggleReduced() } }, this.tr("reduceMotion")),
    );
    const content = h("div", { class: "content" },
      h("div", { class: "logo" },
        h("div", { class: "kanji", "aria-hidden": "true" }, "黒子"),
        h("div", null, h("h1", null, "KUROKO"), h("p", null, this.tr("tagline"))),
      ),
      this.notice ? h("p", { class: "notice", role: "status" }, this.notice) : null,
      menu,
      h("details", { class: "howto" },
        h("summary", null, this.tr("howTo")),
        h("p", null, this.tr("howToText")),
        h("p", null, this.tr("goal", { n: INTEL_GOAL, w: WEEKS })),
        h("p", null, this.tr("keys")),
        h("p", null, this.tr("tapHint")),
      ),
      settings,
    ) as HTMLElement;
    this.notice = "";
    this.mount(h("div", { class: "title" }, canvas, h("div", { class: "veil" }), content));
    this.renderer = new Renderer(canvas);
    this.renderer.reduced = this.settings.reduced;
    this.startDemo();
  }

  private startDemo(): void {
    const r = this.renderer;
    if (!r) return;
    const rng = new Rng(freshCode());
    const city = rng.pick(CITIES);
    const def = generate({ seed: `demo/${seedCode(rng)}`, site: rng.pick(SITES), level: 2, names: (x) => person(x, city).roman });
    this.demo = new Mission(def, { codename: "demo", discretion: 2, nerve: 2, technique: 2 });
    r.setMission(this.demo);
    r.resize();
    const step = () => {
      const d = this.demo;
      if (!d || this.renderer !== r) return;
      const a = ghostAction(d);
      if (!a || d.status !== "play") {
        this.demoTimer = window.setTimeout(() => this.renderer === r && this.startDemo(), 1500);
        return;
      }
      d.act(a);
      r.refresh(d.events);
      this.demoTimer = window.setTimeout(step, this.settings.reduced ? 400 : 240);
    };
    this.demoTimer = window.setTimeout(step, 600);
  }

  private stopDemo(): void {
    window.clearTimeout(this.demoTimer);
    this.demo = null;
  }

  private setLang(l: Lang): void {
    this.settings.lang = l;
    document.documentElement.lang = l;
    this.saveSettings();
    this.rerender();
  }

  private toggleSound(): void {
    this.settings.sound = !this.settings.sound;
    this.audio.enable(this.settings.sound);
    this.rerender();
  }

  private toggleReduced(): void {
    this.settings.reduced = !this.settings.reduced;
    this.saveSettings();
    if (this.renderer) this.renderer.reduced = this.settings.reduced;
    this.rerender();
  }

  private rerender(): void {
    if (this.screen === "title") this.showTitle();
    else if (this.screen === "network") this.showNetwork();
    else if (this.screen === "mission") this.drawMissionUi();
  }

  // ======================= Campaign =======================

  private newCampaign(): void {
    this.confirmNew = false;
    this.campaign = new Campaign(freshCode());
    this.selectedOp = null;
    this.save();
    this.showNetwork();
  }

  private loadCampaign(s: SaveData): void {
    try {
      this.campaign = Campaign.load(s.seed, s.decisions);
    } catch {
      store.set(`${SAVE_KEY}.rejected`, store.get(SAVE_KEY) ?? "");
      store.remove(SAVE_KEY);
      this.notice = this.tr("badSave");
      this.showTitle();
      return;
    }
    const c = this.campaign;
    const cur = s.current;
    if (cur && c.status === "play") {
      const op = c.ops.find((o) => o.id === cur.op);
      const agent = c.agents.find((a) => a.id === cur.agent);
      if (op && agent && agent.status === "ready") {
        this.startMission(c.missionFor(op), agent, { kind: "campaign", op, agent }, cur.log);
        this.say(this.tr("resumed"), false, true);
        return;
      }
    }
    this.showNetwork();
  }

  private showNetwork(): void {
    const c = this.campaign;
    if (!c) return this.showTitle();
    this.screen = "network";
    this.mission = null;
    const L = this.settings.lang;
    const week = Math.min(c.week, WEEKS);
    const gauge = (label: string, value: string, frac: number, cls = "") =>
      h("div", { class: "gauge" }, h("div", { class: "lbl" }, label, h("b", null, value)), h("div", { class: `bar ${cls}` }, h("i", { style: { width: `${Math.round(Math.min(1, frac) * 100)}%` } })));
    const top = h("header", { class: "topbar" },
      h("div", { class: "inner" },
        h("div", { class: "brand" }, "KUROKO", h("span", { "aria-hidden": "true" }, "黒子")),
        h("div", { class: "gauges" },
          gauge(this.tr("week"), `${week} / ${WEEKS}`, week / WEEKS),
          gauge(this.tr("intel"), `${c.intel} / ${INTEL_GOAL}`, c.intel / INTEL_GOAL),
          gauge(this.tr("heat"), `${c.totalHeat()} / ${HEAT_LIMIT}`, c.totalHeat() / HEAT_LIMIT, "heat"),
        ),
        h("button", { class: "btn ghost", on: { click: () => this.showTitle() } }, this.tr("menu")),
      ),
    );
    const body = h("main", { class: "wrap" });
    if (c.status !== "play") {
      const end = c.reports.flatMap((r) => r.items).find((i): i is Extract<Report, { k: "end" }> => i.k === "end");
      body.append(
        h("div", { class: "banner", role: "status" },
          h("p", null, end ? this.reportText(end) : ""),
          h("button", { class: "btn primary", on: { click: () => this.newCampaign() } }, this.tr("newGame")),
        ),
      );
    } else {
      body.append(h("p", { class: "goal" }, this.tr("goal", { n: INTEL_GOAL, w: WEEKS })));
    }

    // Operations.
    const ops = h("div", { class: "ops" });
    if (c.status === "play") {
      for (const op of c.ops) {
        const sel = this.selectedOp === op.id;
        ops.append(
          h("button", { class: "op", "aria-pressed": String(sel), on: { click: () => { this.selectedOp = sel ? null : op.id; this.showNetwork(); } } },
            h("span", { class: "city" }, CITY[L][op.city]),
            h("span", { class: "site" }, SITE[L][op.site]),
            h("span", { class: "meta" },
              h("span", null, `${this.tr("level")} `, pips(op.level, 4)),
              h("span", null, `${this.tr("reward")} +${op.reward}`),
            ),
          ),
        );
      }
    }
    const selOp = c.ops.find((o) => o.id === this.selectedOp) ?? null;

    // Agents.
    const agents = h("div", { class: "list" });
    for (const a of c.agents) {
      const off = a.status === "captured" || a.status === "gone";
      const side = h("div", { class: "side" }, h("span", { class: `chip ${a.status}` }, this.tr(a.status)));
      if (c.status === "play" && a.status === "ready") {
        side.append(
          h("button", { class: "btn primary", disabled: !selOp, on: { click: () => selOp && this.send(selOp, a) } }, selOp ? this.tr("sendTo", { c: CITY[L][selOp.city] }) : this.tr("send")),
        );
      }
      if (c.status === "play" && !off && !c.moleCaught) {
        side.append(h("button", { class: "btn ghost small", on: { click: () => { this.confirmAgent = a.id; this.showNetwork(); } } }, this.tr("confront")));
      }
      const card = h("article", { class: `agent${off ? " off" : ""}` },
        h("div", { class: "who" },
          h("div", { class: "cn" }, a.codename),
          h("div", { class: "nm" }, a.person.native, a.person.native !== a.person.roman ? h("span", null, a.person.roman) : null),
          h("div", { class: "cv" }, `${CITY[L][a.city]} · ${COVER[L][a.cover]}`),
          h("div", { class: "stats" },
            h("span", null, `${this.tr("discretion")} `, pips(a.discretion, 4)),
            h("span", null, `${this.tr("nerve")} `, pips(a.nerve, 4)),
            h("span", null, `${this.tr("technique")} `, pips(a.technique, 4)),
          ),
        ),
        side,
      );
      if (this.confirmAgent === a.id) {
        card.append(
          h("div", { class: "confirm", role: "group" },
            h("p", null, this.tr("confrontAsk", { a: a.codename })),
            h("button", { class: "btn danger", on: { click: () => this.decide({ t: "confront", agent: a.id }) } }, this.tr("yes")),
            h("button", { class: "btn ghost", on: { click: () => { this.confirmAgent = null; this.showNetwork(); } } }, this.tr("no")),
          ),
        );
      }
      agents.append(card);
    }

    // Other decisions.
    const moves = h("div", { class: "moves" },
      h("div", { class: "move" },
        h("button", { class: "btn", disabled: c.status !== "play", on: { click: () => this.decide({ t: "lowkey" }) } }, this.tr("lowkey")),
        h("p", null, this.tr("lowkeyHint")),
      ),
      h("div", { class: "move" },
        h("button", { class: "btn", disabled: c.status !== "play" || !!c.canaries, on: { click: () => this.decide({ t: "canary" }) } }, this.tr(c.canaries ? "canaryDone" : "canary")),
        h("p", null, this.tr("canaryHint")),
      ),
    );

    const heat = h("div", { class: "cities" });
    for (const city of CITIES) {
      const v = c.heat.get(city) ?? 0;
      heat.append(h("div", null, h("span", null, CITY[L][city]), h("span", { "aria-label": `${v} / 5` }, pips(v, 5, "heatpips"))));
    }

    const reports = h("div", { class: "reports" });
    for (const r of c.reports.slice().reverse()) {
      if (r.items.length === 0) continue;
      reports.append(
        h("section", null,
          h("h3", null, `${this.tr("week")} ${Math.min(r.week, WEEKS)}`),
          ...r.items.flatMap((i) => {
            const lines = [h("p", { class: i.k === "chatter" || i.k === "end" || i.k === "confront" ? "hl" : "" }, this.reportText(i))];
            if (i.k === "mission" && i.expected) lines.push(h("p", { class: "hl" }, this.tr("report_leaked")));
            return lines;
          }),
        ),
      );
    }

    body.append(
      c.status === "play" ? h("section", null, h("h2", null, this.tr("ops")), ops, selOp ? null : h("p", { class: "goal" }, this.tr("pickOp"))) : h("span"),
      h("div", { class: "cols" },
        h("section", null, h("h2", null, this.tr("agents")), agents),
        h("div", { style: { display: "grid", gap: "1.5rem", "align-content": "start" } },
          c.status === "play" ? h("section", null, h("h2", null, this.tr("decisions")), moves) : h("span"),
          h("section", null, h("h2", null, this.tr("heatMap")), heat),
          h("section", null, h("h2", null, this.tr("reports")), reports),
        ),
      ),
    );
    const scroll = this.root.querySelector(".screen")?.scrollTop ?? 0;
    const screen = h("div", { class: "screen" }, top, body);
    this.mount(screen);
    screen.scrollTop = scroll;
  }

  private decide(d: Decision): void {
    const c = this.campaign;
    if (!c || !c.decide(d)) return;
    this.confirmAgent = null;
    this.selectedOp = null;
    this.save();
    this.showNetwork();
  }

  private send(op: Op, agent: AgentCard): void {
    const c = this.campaign;
    if (!c) return;
    this.startMission(c.missionFor(op), agent, { kind: "campaign", op, agent }, []);
  }

  private reportText(r: Report): string {
    const L = this.settings.lang;
    const name = (id: number) => this.campaign?.agents.find((a) => a.id === id)?.codename ?? "?";
    switch (r.k) {
      case "mission":
        return this.tr("report_mission", { a: name(r.agent), c: CITY[L][r.op.city], s: SITE[L][r.op.site], o: this.tr(outcomeKey(r.outcome)), i: r.intel, h: r.heat });
      case "lowkey":
        return this.tr("report_lowkey");
      case "canary":
        return this.tr("report_canary", { list: r.fakes.map(([id, city]) => `${name(id)} → ${CITY[L][city]}`).join(", ") });
      case "chatter":
        return this.tr("report_chatter", { c: CITY[L][r.city] });
      case "confront":
        return this.tr(r.mole ? "report_confrontYes" : "report_confrontNo", { a: name(r.agent) });
      case "end":
        return this.tr(r.won ? "report_endWon" : r.reason === "heat" ? "report_endHeat" : r.reason === "agents" ? "report_endAgents" : "report_endTime");
    }
  }

  // ======================= Mission =======================

  private quick(code: string): void {
    const rng = new Rng(`quick/${code}`);
    const city = rng.pick(CITIES);
    const site = rng.pick(SITES);
    const def = generate({ seed: `quick/${code}`, site, level: 2, names: (r) => person(r, city).roman });
    const agent: Agent = { codename: "Kuroko", discretion: 2, nerve: 2, technique: 3 };
    try {
      if (location.hash !== `#mission-${code}`) location.hash = `mission-${code}`;
    } catch {
      /* the hash is a convenience */
    }
    this.startMission(def, agent, { kind: "quick", code, city }, []);
  }

  private startMission(def: MissionDef, agent: Agent, ctx: Ctx, log: readonly Action[]): void {
    this.screen = "mission";
    this.ctx = ctx;
    this.mission = log.length > 0 ? Mission.replay(def, agent, log) : new Mission(def, agent);
    this.runMode = false;
    this.plan = false;
    this.lure = null;
    this.logLines = [];
    const canvas = h("canvas", { role: "img", "aria-label": `${SITE[this.settings.lang][def.site]}` });
    const els = {
      hud: h("header", { class: "hud" }),
      actions: h("nav", { class: "actions", "aria-label": "Actions" }),
      log: h("div", { class: "log", role: "log", "aria-live": "polite" }),
      hint: h("div", { class: "hint", role: "status", hidden: true }),
      modal: h("div", { class: "modal", hidden: true }),
    };
    const stage = h("div", { class: "stage" }, canvas, els.log, els.hint, els.modal);
    this.mount(h("div", { class: "mission" }, els.hud, stage, els.actions));
    this.els = els;
    const r = new Renderer(canvas);
    r.reduced = this.settings.reduced;
    this.renderer = r;
    r.setMission(this.mission);
    canvas.addEventListener("pointerdown", (e) => this.onPointer(e, true));
    canvas.addEventListener("pointermove", (e) => this.onPointer(e, false));
    canvas.addEventListener("pointerleave", () => {
      r.preview = this.lure ? [this.lure] : [];
    });
    this.drawMissionUi();
    // Size the view once the HUD and the buttons have taken their place, and on every change after.
    r.resize();
    new ResizeObserver(() => this.renderer === r && r.resize()).observe(stage);
    if (this.mission.status === "confront") this.showConfront();
  }

  private drawMissionUi(): void {
    const m = this.mission;
    const els = this.els;
    if (!m || !els) return;
    const L = this.settings.lang;
    const c = this.ctx;
    clear(els.hud);
    const stat = (label: string, value: string, cls = "") => h("span", { class: `stat ${cls}` }, label, h("b", null, value));
    const where = c?.kind === "campaign" ? `${CITY[L][c.op.city]} · ${SITE[L][c.op.site]}` : c ? `${CITY[L][c.city]} · ${SITE[L][m.def.site]} · #${c.code}` : "";
    append(els.hud, [
      h("span", { class: "who" }, m.agent.codename),
      h("span", { class: "where" }, where),
      stat(this.tr("turn"), `${m.turn}/${DAWN}`, m.turn > DAWN - 60 ? "hot" : ""),
      stat(this.tr("alarm"), m.alarm > 0 ? String(m.alarm) : "—", m.alarm > 0 ? "hot" : ""),
      stat(this.tr("badge"), m.player.key ? "✓" : "—", m.player.key ? "yes" : ""),
      stat(this.tr("copy"), m.player.photo ? "✓" : "—", m.player.photo ? "yes" : ""),
      stat(this.tr("lures"), String(m.player.coins)),
      m.hidden() ? stat("", this.tr("hidden"), "yes") : null,
      h("span", { class: "spacer" }),
      h("button", { class: "btn ghost snd", style: { "min-height": "2rem", padding: "0.2rem 0.6rem" }, "aria-pressed": String(this.settings.sound), on: { click: () => this.toggleSound() } }, `${this.tr("sound")} : ${this.tr(this.settings.sound ? "on" : "off")}`),
      h("button", { class: "btn ghost", style: { "min-height": "2rem", padding: "0.2rem 0.6rem" }, on: { click: () => this.leaveToMenu() } }, this.tr("menu")),
    ]);

    // Rebuilding the buttons must not lose the keyboard focus.
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && els.actions.contains(active) ? active.getAttribute("aria-keyshortcuts") : null;
    clear(els.actions);
    const play = m.status === "play";
    const hint = m.useHint();
    const useLabel: Key = hint === "key" ? "useBadge" : hint === "photo" ? "usePhoto" : hint === "unlock" ? "useUnlock" : hint === "panel" ? (m.circuitsOn.has(m.itemNear("panel")?.circuit ?? -1) ? "usePanel" : "usePanelOn") : "use";
    const onExit = m.def.exits.some((e) => eq(e, m.player.at));
    const btn = (label: string, key: string, fn: () => void, opts: { disabled?: boolean; pressed?: boolean; extra?: string; title?: string } = {}) =>
      h("button", { class: "btn", disabled: !play || !!opts.disabled, "aria-pressed": opts.pressed === undefined ? undefined : String(opts.pressed), title: opts.title, "aria-keyshortcuts": key, on: { click: fn } },
        h("span", null, label),
        opts.extra ? h("small", null, opts.extra) : null,
        h("kbd", null, key),
      );
    els.actions.append(
      btn(this.tr("wait"), "Space", () => this.act({ t: "wait" })),
      btn(this.tr("run"), "Shift", () => { this.runMode = !this.runMode; this.drawMissionUi(); }, { pressed: this.runMode }),
      btn(this.tr("pick"), "F", () => this.act({ t: "pick" }), { disabled: !m.lockedNear() || m.player.picked, extra: m.lockedNear() ? this.tr("odds", { p: Math.round(m.pickOdds() * 100) }) : "" }),
      btn(this.tr(useLabel), "E", () => this.act({ t: "use" }), { disabled: !hint }),
      btn(this.tr("lure"), "T", () => this.toggleLure(), { disabled: m.player.coins <= 0, pressed: !!this.lure, extra: `×${m.player.coins}` }),
      btn(this.tr("plan"), "V", () => this.togglePlan(), { pressed: this.plan, title: this.tr("planHint") }),
      btn(this.tr("leave"), "X", () => this.act({ t: "leave" }), { disabled: !onExit }),
    );

    if (focusKey) {
      const b = els.actions.querySelector<HTMLButtonElement>(`[aria-keyshortcuts="${focusKey}"]`);
      if (b && !b.disabled) b.focus();
      else els.actions.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
    clear(els.log);
    for (const l of this.logLines.slice(-5)) els.log.append(h("p", { class: l.bad ? "bad" : "" }, l.text));

    if (this.lure) {
      els.hint.hidden = false;
      clear(els.hint);
      els.hint.append(`${this.tr("lureHint")} ${this.tr("lureCancel")}`);
    } else if (this.plan) {
      els.hint.hidden = false;
      clear(els.hint);
      els.hint.append(this.tr("planHint"));
    } else {
      els.hint.hidden = true;
    }
  }

  private say(text: string, bad = false, redraw = false): void {
    this.logLines.push({ text, bad });
    if (this.logLines.length > 40) this.logLines.shift();
    if (redraw) this.drawMissionUi();
  }

  private guardName(id: number): string {
    return this.mission?.guards.find((g) => g.id === id)?.name ?? "?";
  }

  /** Plays one action and everything that follows from it. */
  private act(a: Action): boolean {
    const m = this.mission;
    if (!m || this.screen !== "mission") return false;
    const was = { key: m.player.key, photo: m.player.photo };
    if (!m.act(a)) {
      this.audio.play("fail");
      this.say(this.tr("invalid"), true, true);
      return false;
    }
    const sounds = new Set<Sfx>();
    if (a.t === "step") sounds.add("step");
    if (a.t === "run") sounds.add("run");
    if (a.t === "throw") sounds.add("lure");
    for (const e of m.events) this.narrate(e, sounds);
    if (!was.key && m.player.key) sounds.add("badge");
    if (!was.photo && m.player.photo) sounds.add("copy");
    for (const s of sounds) this.audio.play(s);
    this.renderer?.refresh(m.events, this.plan);
    if (a.t === "throw") this.lure = null;
    this.save();
    this.drawMissionUi();
    if (m.status === "confront") this.showConfront();
    if (m.status === "done") {
      this.stopWalk();
      const out = m.outcome as Outcome;
      this.audio.play(GOOD.includes(out) || out === "loud" ? "win" : "fail");
      window.setTimeout(() => this.finishMission(), this.settings.reduced ? 300 : 900);
    }
    return true;
  }

  private narrate(e: Event, sounds: Set<Sfx>): void {
    switch (e.k) {
      case "notice":
        sounds.add("notice");
        return this.say(this.tr("log_notice", { g: this.guardName(e.guard) }));
      case "spotted":
        sounds.add("alert");
        return this.say(this.tr("log_spotted", { g: this.guardName(e.guard) }), true);
      case "radio":
        sounds.add("alert");
        return this.say(this.tr("log_radio", { g: this.guardName(e.guard) }), true);
      case "found":
        sounds.add("alert");
        return this.say(this.tr("log_found", { g: this.guardName(e.guard) }), true);
      case "dice": {
        const r = e.roll;
        const d = `(${r.dice[0]}+${r.dice[1]})`;
        const vars = { d, b: r.bonus, t: r.total, n: r.target };
        if (e.what === "pick") {
          sounds.add("pick");
          return this.say(this.tr("log_pick", { ...vars, r: this.tr(r.margin >= 3 ? "log_pickFast" : r.ok ? "log_pickOk" : "log_pickSlow") }));
        }
        return this.say(this.tr("log_bluff", { ...vars, r: this.tr(r.ok ? "log_bluffOk" : "log_bluffKo") }), !r.ok);
      }
      case "unlock":
        sounds.add("unlock");
        return this.say(this.tr("log_unlock"));
      case "key":
        return this.say(this.tr("log_key"));
      case "photo":
        return this.say(this.tr("log_photo"));
      case "lights":
        sounds.add("relay");
        return this.say(this.tr(e.on ? "log_lightsOn" : "log_lightsOff"));
      case "confront":
        sounds.add("alert");
        return this.say(this.tr("log_confront", { g: this.guardName(e.guard) }), true);
      case "noise":
      case "end":
        return;
    }
  }

  private showConfront(): void {
    const m = this.mission;
    const els = this.els;
    if (!m || !els || m.confronting === null) return;
    this.stopWalk();
    clear(els.modal);
    const bluff = h("button", { class: "btn primary", on: { click: () => { els.modal.hidden = true; this.act({ t: "bluff" }); } } }, this.tr("bluff"), h("small", null, this.tr("odds", { p: Math.round(m.bluffOdds() * 100) })));
    els.modal.append(
      h("div", { class: "card", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "confront-title" },
        h("h2", { id: "confront-title" }, this.tr("confrontTitle")),
        h("p", null, this.tr("confrontText", { g: this.guardName(m.confronting) })),
        h("p", { class: "num", style: { color: "var(--muted)", "font-size": "var(--step--1)" } }, `2d6 + ${m.agent.nerve} ≥ ${m.bluffTarget()}`),
        h("div", { class: "row" },
          bluff,
          h("button", { class: "btn", on: { click: () => { els.modal.hidden = true; this.act({ t: "flee" }); } } }, this.tr("flee")),
        ),
      ),
    );
    els.modal.hidden = false;
    bluff.focus();
  }

  private toggleLure(): void {
    const m = this.mission;
    if (!m || m.status !== "play") return;
    this.stopWalk();
    this.lure = this.lure ? null : { ...m.player.at };
    this.updateTargets();
    this.drawMissionUi();
  }

  private updateTargets(): void {
    const m = this.mission;
    const r = this.renderer;
    if (!m || !r) return;
    r.targets = [];
    if (this.lure) {
      for (let y = m.player.at.y - 6; y <= m.player.at.y + 6; y++) {
        for (let x = m.player.at.x - 6; x <= m.player.at.x + 6; x++) if (m.canThrowAt({ x, y })) r.targets.push({ x, y });
      }
      r.preview = [this.lure];
    } else {
      r.preview = [];
    }
  }

  private togglePlan(): void {
    this.plan = !this.plan;
    this.renderer?.refresh(null, this.plan);
    this.drawMissionUi();
  }

  private leaveToMenu(): void {
    this.save();
    this.mission = null;
    try {
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* fine */
    }
    if (this.ctx?.kind === "campaign") this.showNetwork();
    else this.showTitle();
  }

  // ---------- Input ----------

  private move(d: Dir, run: boolean): void {
    this.act(run ? { t: "run", d } : { t: "step", d });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.screen !== "mission") return;
    const m = this.mission;
    if (!m) return;
    const target = e.target as HTMLElement | null;
    const onButton = target?.tagName === "BUTTON";
    if (m.status === "confront") return;
    // Physical keys: WASD on QWERTY is ZQSD on AZERTY, so both work with no setting.
    const dirs: Record<string, Dir> = {
      ArrowUp: 0, KeyW: 0, Numpad8: 0,
      PageUp: 1, Numpad9: 1,
      ArrowRight: 2, KeyD: 2, Numpad6: 2,
      PageDown: 3, Numpad3: 3,
      ArrowDown: 4, KeyS: 4, Numpad2: 4,
      End: 5, Numpad1: 5,
      ArrowLeft: 6, KeyA: 6, Numpad4: 6,
      Home: 7, Numpad7: 7,
    };
    const d = dirs[e.code];
    const now = performance.now();
    if (d !== undefined) {
      e.preventDefault();
      if (e.repeat && now - this.lastKey < 120) return;
      this.lastKey = now;
      this.stopWalk();
      if (this.lure) {
        const v = DIRS[d] as Pt;
        const next = { x: this.lure.x + v.x, y: this.lure.y + v.y };
        if (Math.hypot(next.x - m.player.at.x, next.y - m.player.at.y) <= 6) this.lure = next;
        this.updateTargets();
        return;
      }
      this.move(d, e.shiftKey || this.runMode);
      return;
    }
    if (e.repeat && e.code !== "Space") return;
    switch (e.code) {
      case "Space":
      case "Numpad5":
      case "Period":
        if (onButton && e.code === "Space") return;
        e.preventDefault();
        if (e.repeat && now - this.lastKey < 120) return;
        this.lastKey = now;
        this.stopWalk();
        this.act({ t: "wait" });
        return;
      case "KeyF":
        this.stopWalk();
        this.act({ t: "pick" });
        return;
      case "KeyE":
        this.stopWalk();
        this.act({ t: "use" });
        return;
      case "KeyT":
        if (this.lure && m.canThrowAt(this.lure)) this.act({ t: "throw", at: this.lure });
        else this.toggleLure();
        return;
      case "Enter":
      case "NumpadEnter":
        if (this.lure && !onButton) {
          e.preventDefault();
          if (m.canThrowAt(this.lure)) this.act({ t: "throw", at: this.lure });
        }
        return;
      case "KeyV":
        this.togglePlan();
        return;
      case "KeyX":
        this.stopWalk();
        this.act({ t: "leave" });
        return;
      case "Escape":
        this.stopWalk();
        if (this.lure) this.toggleLure();
        return;
    }
  }

  private onPointer(e: PointerEvent, down: boolean): void {
    const m = this.mission;
    const r = this.renderer;
    if (!m || !r || m.status !== "play") return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const tile = r.tileAt(e.clientX - rect.left, e.clientY - rect.top);
    if (this.lure) {
      if (!down) {
        if (Math.hypot(tile.x - m.player.at.x, tile.y - m.player.at.y) <= 6) this.lure = tile;
        r.preview = [this.lure];
        return;
      }
      if (m.canThrowAt(tile)) this.act({ t: "throw", at: tile });
      else this.toggleLure();
      return;
    }
    const route = this.routeTo(tile);
    if (!down) {
      if (e.pointerType === "mouse") r.preview = route ? route.slice(1, 60) : [];
      return;
    }
    e.preventDefault();
    this.stopWalk();
    if (!route || route.length < 2) {
      if (eq(tile, m.player.at)) this.act({ t: "wait" });
      return;
    }
    this.walk = route.slice(1);
    this.walkStep();
  }

  /** A walking route to a tile, or to the closest free tile next to it (a desk, a panel). */
  private routeTo(tile: Pt): Pt[] | null {
    const m = this.mission;
    if (!m || !m.grid.in(tile.x, tile.y)) return null;
    const guard = (x: number, y: number) => m.guards.some((g) => g.at.x === x && g.at.y === y);
    if (m.grid.walkable(tile.x, tile.y)) return path(m.grid, m.player.at, tile, guard);
    let best: Pt[] | null = null;
    for (const d of DIRS) {
      const n = { x: tile.x + d.x, y: tile.y + d.y };
      if (!m.grid.walkable(n.x, n.y)) continue;
      const p = path(m.grid, m.player.at, n, guard);
      if (p && (!best || p.length < best.length)) best = p;
    }
    return best;
  }

  /** Auto-walk, one turn at a time, stopping the moment anything happens. */
  private walkStep(): void {
    const m = this.mission;
    const next = this.walk[0];
    if (!m || !next || m.status !== "play") return this.stopWalk();
    const d = dirTo(m.player.at, next);
    const after = this.walk[1];
    const run = this.runMode && !!after && dirTo(next, after) === d;
    const before = m.guards.map((g) => g.mode);
    if (!this.act(run ? { t: "run", d } : { t: "step", d })) return this.stopWalk();
    this.walk.splice(0, run ? 2 : 1);
    const alarming = m.events.some((e) => e.k !== "noise") || m.guards.some((g, i) => g.sight || g.mode !== before[i]);
    if (alarming || this.walk.length === 0) return this.stopWalk();
    if (this.renderer) this.renderer.preview = this.walk.slice(0, 60);
    this.walkTimer = window.setTimeout(() => this.walkStep(), this.settings.reduced ? 90 : 150);
  }

  private stopWalk(): void {
    window.clearTimeout(this.walkTimer);
    this.walk = [];
    if (this.renderer && !this.lure) this.renderer.preview = [];
  }

  // ======================= Debrief =======================

  private finishMission(): void {
    const m = this.mission;
    const ctx = this.ctx;
    if (!m || !ctx || m.status !== "done" || this.screen !== "mission") return;
    const out = m.outcome as Outcome;
    const L = this.settings.lang;
    const facts: [string, string][] = [
      [this.tr("yourTime"), this.tr("turns", { n: m.turn })],
      [this.tr("ghostProof"), this.tr("ghostProofText", { n: m.def.ghost.length - 1 })],
      [this.tr("peak"), `${Math.round(m.peak)} / 100`],
    ];
    const buttons: HTMLElement[] = [];
    if (ctx.kind === "campaign") {
      const c = this.campaign as Campaign;
      c.decide({ t: "mission", op: ctx.op.id, agent: ctx.agent.id, log: m.log.slice() });
      this.mission = null;
      this.save();
      const rep = c.reports.flatMap((r) => r.items).reverse().find((i): i is Extract<Report, { k: "mission" }> => i.k === "mission");
      if (rep) {
        facts.push([this.tr("intel"), `+${rep.intel}`], [this.tr("heat"), `+${rep.heat} · ${CITY[L][rep.op.city]}`]);
      }
      buttons.push(h("button", { class: "btn primary", on: { click: () => this.showNetwork() } }, this.tr("back")));
      if (rep?.expected) facts.push(["!", this.tr("report_leaked")]);
    } else {
      buttons.push(
        h("button", { class: "btn primary", on: { click: () => this.quick(freshCode()) } }, this.tr("newSeed")),
        h("button", { class: "btn", on: { click: () => this.quick(ctx.code) } }, this.tr("retry")),
        h("button", { class: "btn ghost", on: { click: () => this.leaveToMenu() } }, this.tr("menu")),
      );
      facts.unshift([this.tr("missionCode"), ctx.code]);
    }
    this.screen = "debrief";
    const cls = GOOD.includes(out) ? "" : MID.includes(out) ? "mid" : "bad";
    const card = h("div", { class: "card", role: "status" },
      h("h2", null, this.tr("result")),
      h("div", { class: `stamp ${cls}` }, this.tr(outcomeKey(out))),
      h("p", null, this.tr(`outcomeText_${out}` as Key)),
      h("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)])),
      h("div", { class: "row" }, ...buttons),
    );
    this.mount(h("div", { class: "screen" }, h("div", { class: "debrief" }, card)));
    (buttons[0] as HTMLElement).focus();
  }
}

function pips(n: number, max: number, cls = ""): HTMLElement {
  const el = h("span", { class: `pips ${cls}`, "aria-label": `${n} / ${max}`, role: "img" });
  for (let i = 0; i < max; i++) el.append(h("i", { class: i < n ? "on" : "" }));
  return el;
}
