import assert from "node:assert/strict";
import { ghostAction } from "../src/core/ghost.js";
import { Mission, type Agent } from "../src/core/mission.js";
import type { MissionDef } from "../src/core/types.js";

/** Plays the solver's ghost route in the real game, turn for turn. */
export function playGhost(def: MissionDef, agent: Agent): Mission {
  const m = new Mission(def, agent);
  for (let guard = 0; guard < 1000 && m.status === "play"; guard++) {
    const a = ghostAction(m);
    if (!a) break;
    assert.ok(m.act(a), `action ${a.t} refused at turn ${m.turn}`);
  }
  return m;
}
