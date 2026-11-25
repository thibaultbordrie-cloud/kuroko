import { test } from "node:test";
import assert from "node:assert/strict";
import { Campaign, HEAT_LIMIT, WEEKS, type Decision } from "../src/core/campaign.js";
import { Mission } from "../src/core/mission.js";
import { playGhost } from "./helpers.js";

/** Plays a week: the first ready agent on the first operation, along the proven ghost route. */
function ghostWeek(c: Campaign): Decision {
  const agent = c.ready()[0];
  const op = c.ops[0];
  if (!agent || !op) return { t: "lowkey" };
  const m = playGhost(c.missionFor(op), agent);
  return { t: "mission", op: op.id, agent: agent.id, log: m.log };
}

test("a campaign starts with five agents in different cities, three operations, no heat", () => {
  const c = new Campaign("start");
  assert.equal(c.agents.length, 5);
  assert.equal(new Set(c.agents.map((a) => a.city)).size, 5);
  assert.equal(new Set(c.agents.map((a) => a.codename)).size, 5);
  for (const a of c.agents) {
    assert.equal(a.discretion + a.nerve + a.technique, 7);
    for (const s of [a.discretion, a.nerve, a.technique]) assert.ok(s >= 1 && s <= 4);
  }
  assert.equal(c.ops.length, 3);
  assert.equal(c.totalHeat(), 0);
});

test("ghost missions bring intel and no heat; the save replays to the same state", () => {
  const c = new Campaign("ghosts");
  for (let w = 0; w < 3; w++) assert.ok(c.decide(ghostWeek(c)));
  assert.equal(c.week, 4);
  assert.ok(c.intel >= 3 + 3);
  assert.equal(c.totalHeat(), 0);
  const again = Campaign.load("ghosts", c.decisions);
  assert.equal(again.intel, c.intel);
  assert.equal(again.week, c.week);
  assert.deepEqual(again.agents, c.agents);
});

test("a save with a forged result does not load", () => {
  const c = new Campaign("forge");
  const d = ghostWeek(c);
  assert.ok(c.decide(d));
  // Cut the mission log short: the mission never ended, so the decision is refused.
  const forged: Decision[] = [{ ...(d as Extract<Decision, { t: "mission" }>), log: (d as Extract<Decision, { t: "mission" }>).log.slice(0, 5) }];
  assert.throws(() => Campaign.load("forge", forged));
});

test("canaries name the mole: the chatter points to the lead only the mole was given", () => {
  for (let s = 0; s < 6; s++) {
    const c = new Campaign(`mole-${s}`);
    assert.ok(c.decide({ t: "canary" }));
    assert.ok(c.decide({ t: "lowkey" }));
    const chatter = c.reports.flatMap((r) => r.items).find((i) => i.k === "chatter");
    assert.ok(chatter && chatter.k === "chatter");
    const suspect = [...(c.canaries as Map<number, string>).entries()].filter(([, city]) => city === chatter.city).map(([id]) => id);
    assert.equal(suspect.length, 1, "each lead is unique");
    assert.ok(c.isMole(suspect[0] as number));
    const intel = c.intel;
    assert.ok(c.decide({ t: "confront", agent: suspect[0] as number }));
    assert.ok(c.moleCaught);
    assert.equal(c.intel, intel + 3);
    assert.equal(c.moleActive, false);
  }
});

test("accusing an innocent costs an agent and catches nobody", () => {
  const c = new Campaign("wrong");
  const innocent = c.agents.find((a) => !c.isMole(a.id));
  assert.ok(innocent);
  assert.ok(c.decide({ t: "confront", agent: innocent.id }));
  assert.equal(innocent.status, "gone");
  assert.equal(c.moleCaught, false);
});

test("the mole leaks one operation a week, until caught", () => {
  const c = new Campaign("leaks");
  assert.equal(c.ops.filter((o) => c.wasLeaked(o)).length, 1);
  const mole = c.agents.find((a) => c.isMole(a.id));
  assert.ok(mole);
  c.decide({ t: "confront", agent: mole.id });
  c.decide({ t: "lowkey" });
  assert.equal(c.ops.filter((o) => c.wasLeaked(o)).length, 0);
});

test("a campaign ends after twelve weeks, or when the heat is too high", () => {
  const c = new Campaign("time");
  for (let w = 0; w < WEEKS; w++) c.decide({ t: "lowkey" });
  assert.equal(c.status, "lost");
  assert.equal(c.decide({ t: "lowkey" }), false);
  const h = new Campaign("heat");
  // Burn agents loudly until the network is rolled up or no one is left.
  for (let w = 0; w < WEEKS && h.status === "play"; w++) {
    const agent = h.ready()[0];
    const op = h.ops[0];
    if (!agent || !op) {
      h.decide({ t: "lowkey" });
      continue;
    }
    const m = new Mission(h.missionFor(op), agent);
    // Walk straight at the nearest guard and own up.
    for (let i = 0; i < 300 && m.status !== "done"; i++) {
      if (m.status === "confront") m.act({ t: "bluff" });
      else if (!m.act({ t: "run", d: 2 }) && !m.act({ t: "run", d: 6 })) m.act({ t: "wait" });
    }
    if (m.status !== "done") m.act({ t: "leave" });
    if (m.status !== "done") {
      h.decide({ t: "lowkey" });
      continue;
    }
    h.decide({ t: "mission", op: op.id, agent: agent.id, log: m.log });
  }
  assert.ok(h.totalHeat() < HEAT_LIMIT || h.status === "lost");
});
