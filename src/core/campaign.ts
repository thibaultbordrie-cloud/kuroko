/**
 * The network: a handful of agents across eight cities, twelve weeks, one mole.
 * Each week the player sends one agent on one operation (a mission), lies low, or plants
 * canaries to find the mole. A campaign is saved as its seed and its list of decisions, with
 * each mission's own action log: loading replays everything, so a result cannot be edited in.
 */
import { generate } from "./gen.js";
import { Mission, type Action, type Agent, type Outcome } from "./mission.js";
import { CITIES, codename, person, type City, type Person } from "./names.js";
import { Rng } from "./rng.js";
import type { MissionDef, Site } from "./types.js";

export const WEEKS = 12;
export const INTEL_GOAL = 12;
export const HEAT_LIMIT = 20;

export type Cover = "courier" | "nurse" | "driver" | "translator" | "technician" | "journalist" | "student" | "streamer";
const COVERS: readonly Cover[] = ["courier", "nurse", "driver", "translator", "technician", "journalist", "student", "streamer"];
const SITES: readonly Site[] = ["datacenter", "consulate", "biolab", "port", "tower", "studio"];

export interface AgentCard extends Agent {
  readonly id: number;
  readonly person: Person;
  readonly city: City;
  readonly cover: Cover;
  status: "ready" | "low" | "captured" | "gone";
  /** Weeks left lying low after a blown cover. */
  lowFor: number;
}

export interface Op {
  readonly id: number;
  readonly city: City;
  readonly site: Site;
  readonly level: number;
  readonly reward: number;
  readonly seed: string;
}

export type Decision =
  | { readonly t: "mission"; readonly op: number; readonly agent: number; readonly log: readonly Action[] }
  | { readonly t: "lowkey" }
  | { readonly t: "canary" }
  | { readonly t: "confront"; readonly agent: number };

export type Report =
  | { readonly k: "mission"; readonly agent: number; readonly op: Op; readonly outcome: Outcome; readonly intel: number; readonly heat: number; readonly expected: boolean }
  | { readonly k: "lowkey" }
  | { readonly k: "canary"; readonly fakes: readonly (readonly [number, City])[] }
  | { readonly k: "chatter"; readonly city: City }
  | { readonly k: "confront"; readonly agent: number; readonly mole: boolean }
  | { readonly k: "end"; readonly won: boolean; readonly reason: "time" | "heat" | "agents" };

export class Campaign {
  readonly seed: string;
  week = 1;
  intel = 0;
  readonly heat = new Map<City, number>();
  readonly agents: AgentCard[] = [];
  ops: Op[] = [];
  readonly decisions: Decision[] = [];
  /** What happened, week by week, for the reports screen. */
  readonly reports: { week: number; items: Report[] }[] = [];
  status: "play" | "won" | "lost" = "play";
  moleCaught = false;
  /** The fake leads given to each agent, once canaries are planted. */
  canaries: Map<number, City> | null = null;
  private chatterDue = false;
  private readonly moleId: number;
  /** Operations the mole has leaked this week: harder than they look. */
  private compromised = new Set<number>();
  private readonly rng: Rng;

  constructor(seed: string) {
    this.seed = seed;
    this.rng = new Rng(`${seed}/campaign`);
    for (const c of CITIES) this.heat.set(c, 0);
    const taken = new Set<string>();
    const cities = this.rng.shuffle(CITIES);
    for (let i = 0; i < 5; i++) {
      const city = cities[i] as City;
      const cn = codename(this.rng, taken);
      taken.add(cn);
      // Seven points over three skills, each from 1 to 4.
      const s = [1, 1, 1];
      for (let k = 0; k < 4; k++) {
        const j = this.rng.int(0, 2);
        if ((s[j] as number) < 4) s[j] = (s[j] as number) + 1;
        else k--;
      }
      this.agents.push({
        id: i, codename: cn, person: person(this.rng, city), city, cover: this.rng.pick(COVERS),
        discretion: s[0] as number, nerve: s[1] as number, technique: s[2] as number, status: "ready", lowFor: 0,
      });
    }
    this.moleId = this.rng.int(0, 4);
    this.newWeek();
  }

  static load(seed: string, decisions: readonly Decision[]): Campaign {
    const c = new Campaign(seed);
    for (const d of decisions) {
      if (!c.decide(d)) throw new Error("this save does not replay: it was changed or is from another version");
    }
    return c;
  }

  /** Is the mole still at work? Only the game knows who it is. */
  get moleActive(): boolean {
    const m = this.agents[this.moleId];
    return !this.moleCaught && !!m && m.status !== "captured" && m.status !== "gone";
  }

  isMole(id: number): boolean {
    return id === this.moleId;
  }

  ready(): AgentCard[] {
    return this.agents.filter((a) => a.status === "ready");
  }

  /** The mission for an operation, as the agent will find it (a leaked one is harder). */
  missionFor(op: Op): MissionDef {
    const level = Math.min(4, op.level + (this.compromised.has(op.id) ? 1 : 0));
    return generate({ seed: op.seed, site: op.site, level, names: (r) => person(r, op.city).roman });
  }

  wasLeaked(op: Op): boolean {
    return this.compromised.has(op.id);
  }

  totalHeat(): number {
    let s = 0;
    for (const v of this.heat.values()) s += v;
    return s;
  }

  /** Applies one decision. Returns false, changing nothing, if it is not allowed now. */
  decide(d: Decision): boolean {
    if (this.status !== "play") return false;
    const items: Report[] = [];
    switch (d.t) {
      case "mission": {
        const op = this.ops.find((o) => o.id === d.op);
        const agent = this.agents.find((a) => a.id === d.agent);
        if (!op || !agent || agent.status !== "ready") return false;
        const m = Mission.replay(this.missionFor(op), agent, d.log);
        if (m.status !== "done" || !m.outcome) return false;
        const { intel, heat } = this.settle(op, agent, m.outcome);
        items.push({ k: "mission", agent: agent.id, op, outcome: m.outcome, intel, heat, expected: this.compromised.has(op.id) });
        break;
      }
      case "lowkey": {
        for (const c of CITIES) this.heat.set(c, Math.max(0, (this.heat.get(c) ?? 0) - 1));
        items.push({ k: "lowkey" });
        break;
      }
      case "canary": {
        if (this.canaries) return false;
        // A different false lead for each agent still in the network.
        const live = this.agents.filter((a) => a.status === "ready" || a.status === "low");
        const fakes = this.rng.shuffle(CITIES).slice(0, live.length);
        this.canaries = new Map(live.map((a, i) => [a.id, fakes[i] as City]));
        this.chatterDue = true;
        items.push({ k: "canary", fakes: [...this.canaries.entries()] });
        break;
      }
      case "confront": {
        const a = this.agents.find((x) => x.id === d.agent);
        if (!a || a.status === "captured" || a.status === "gone" || this.moleCaught) return false;
        const mole = a.id === this.moleId;
        if (mole) {
          this.moleCaught = true;
          this.intel += 3;
        }
        // Either way the agent leaves the network: the mole to a safe house, the innocent in anger.
        a.status = "gone";
        items.push({ k: "confront", agent: a.id, mole });
        this.decisions.push(d);
        this.report(items);
        this.checkEnd();
        // Confronting takes no week.
        return true;
      }
    }
    this.decisions.push(d);
    this.endWeek(items);
    return true;
  }

  private settle(op: Op, agent: AgentCard, o: Outcome): { intel: number; heat: number } {
    let intel = 0;
    let heat = 0;
    switch (o) {
      case "ghost":
        intel = op.reward + 1;
        break;
      case "quiet":
        intel = op.reward;
        break;
      case "loud":
        intel = op.reward;
        heat = 1;
        break;
      case "burned":
        intel = Math.max(0, op.reward - 1);
        heat = 2;
        agent.status = "low";
        agent.lowFor = 2;
        break;
      case "captured":
        heat = 2;
        agent.status = "captured";
        break;
      case "aborted":
      case "dawn":
        break;
    }
    this.intel += intel;
    this.heat.set(op.city, Math.min(5, (this.heat.get(op.city) ?? 0) + heat));
    return { intel, heat };
  }

  private endWeek(items: Report[]): void {
    for (const a of this.agents) {
      if (a.status === "low" && --a.lowFor <= 0) a.status = "ready";
    }
    // The canary sings the week after it is planted: the opposition reacts to the mole's lead.
    if (this.chatterDue && this.canaries && !items.some((i) => i.k === "canary")) {
      this.chatterDue = false;
      const lead = this.moleActive ? this.canaries.get(this.moleId) : undefined;
      if (lead) items.push({ k: "chatter", city: lead });
    }
    this.report(items);
    this.week++;
    this.checkEnd();
    if (this.status === "play") this.newWeek();
  }

  private report(items: Report[]): void {
    const last = this.reports[this.reports.length - 1];
    if (last && last.week === this.week) last.items.push(...items);
    else this.reports.push({ week: this.week, items });
  }

  private checkEnd(): void {
    if (this.status !== "play") return;
    let reason: "time" | "heat" | "agents" | null = null;
    if (this.totalHeat() >= HEAT_LIMIT) reason = "heat";
    else if (!this.agents.some((a) => a.status === "ready" || a.status === "low")) reason = "agents";
    else if (this.week > WEEKS) reason = "time";
    if (!reason) return;
    const won = reason === "time" && this.intel >= INTEL_GOAL;
    this.status = won ? "won" : "lost";
    this.report([{ k: "end", won, reason }]);
  }

  private newWeek(): void {
    const wr = new Rng(`${this.seed}/week${this.week}`);
    const open = CITIES.filter((c) => (this.heat.get(c) ?? 0) < 5);
    const cities = wr.shuffle(open.length >= 3 ? open : CITIES).slice(0, 3);
    this.ops = cities.map((city, i) => {
      const heat = this.heat.get(city) ?? 0;
      const level = Math.min(3, 1 + Math.floor((this.week - 1) / 4) + (heat >= 3 ? 1 : 0) + (i === 2 ? 1 : 0));
      return { id: this.week * 10 + i, city, site: wr.pick(SITES), level, reward: level, seed: `${this.seed}/w${this.week}/o${i}` };
    });
    this.compromised = new Set();
    if (this.moleActive) {
      const mole = this.agents[this.moleId] as AgentCard;
      // The mole leaks one operation a week, never one it could be sent on alone.
      const target = wr.pick(this.ops);
      if (mole.status !== "captured") this.compromised.add(target.id);
    }
  }
}
