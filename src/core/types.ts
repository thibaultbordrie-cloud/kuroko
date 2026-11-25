import type { Dir, Grid, Lamp, Panel, Pt, Room } from "./map.js";

/** One step of a guard's round: where they stand and where they look. */
export interface RouteStep {
  readonly at: Pt;
  readonly facing: Dir;
}

export type Site = "datacenter" | "consulate" | "biolab" | "port" | "tower" | "studio";

export interface GuardDef {
  readonly id: number;
  readonly name: string;
  readonly route: readonly RouteStep[];
  /** Guards who stay at a post turn their head; others walk a loop. */
  readonly post: boolean;
}

export type ItemKind = "document" | "key" | "panel";

export interface Item {
  readonly kind: ItemKind;
  /** The tile the object sits on (a desk, a wall); used from any neighbouring tile. */
  readonly at: Pt;
  readonly circuit?: number;
}

/** A generated mission: immutable. The play state is built from it. */
export interface MissionDef {
  readonly seed: string;
  readonly site: Site;
  readonly level: number;
  readonly grid: Grid;
  readonly rooms: readonly Room[];
  readonly lamps: readonly Lamp[];
  readonly panels: readonly Panel[];
  readonly ambient: Uint8Array;
  readonly entry: Pt;
  readonly exits: readonly Pt[];
  readonly items: readonly Item[];
  readonly guards: readonly GuardDef[];
  /** Lock difficulty of the archive door. */
  readonly lock: number;
  /** A route the solver found that no guard ever sees: proof the mission can be done unseen. */
  readonly ghost: readonly Pt[];
}
