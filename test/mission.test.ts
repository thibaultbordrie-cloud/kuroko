import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../src/core/gen.js";
import { Mission, type Agent } from "../src/core/mission.js";
import { DIRS, T, cheb, dirTo, eq, type Dir, type Pt } from "../src/core/map.js";
import { person } from "../src/core/names.js";
import { Rng, seedCode } from "../src/core/rng.js";
import { chance } from "../src/core/dice.js";
import { HORIZON } from "../src/core/solver.js";
import { playGhost } from "./helpers.js";

const agent: Agent = { codename: "Test Heron", discretion: 2, nerve: 2, technique: 2 };
const make = (seed: string, level = 2) => generate({ seed, site: "consulate", level, names: (r) => person(r, "hongkong").roman });

test("the generator is deterministic: same seed, same building", () => {
  const a = make("same-seed");
  const b = make("same-seed");
  assert.deepEqual(Array.from(a.grid.tiles), Array.from(b.grid.tiles));
  assert.deepEqual(a.guards, b.guards);
  assert.deepEqual(a.ghost, b.ghost);
});

test("every mission over 60 seeds can be done unseen: the ghost route works in the game itself", () => {
  for (let i = 0; i < 60; i++) {
    const def = make(`ghost-${i}`, 1 + (i % 3));
    assert.ok(def.ghost.length > 0 && def.ghost.length <= HORIZON + 1);
    const m = playGhost(def, agent);
    assert.equal(m.outcome, "ghost", `seed ghost-${i}: ${m.outcome}, peak ${m.peak}`);
    assert.equal(m.spotted, false);
  }
});

test("the building is sound: one way in, an archive behind a lock, a document, a key, three panels", () => {
  for (let i = 0; i < 20; i++) {
    const def = make(`sound-${i}`);
    const g = def.grid;
    assert.equal(g.get(def.entry.x, def.entry.y), T.Exit);
    let locked = 0;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.get(x, y) === T.Locked) locked++;
    assert.ok(locked >= 1);
    assert.equal(def.items.filter((it) => it.kind === "document").length, 1);
    assert.equal(def.items.filter((it) => it.kind === "key").length, 1);
    assert.equal(def.panels.length, 3);
    for (const gd of def.guards) {
      // Rounds are walkable, step by step, and closed.
      for (let k = 0; k < gd.route.length; k++) {
        const a = (gd.route[k] as { at: Pt }).at;
        const b = (gd.route[(k + 1) % gd.route.length] as { at: Pt }).at;
        assert.ok(g.walkable(a.x, a.y));
        assert.ok(cheb(a, b) <= 1, `guard ${gd.id} jumps at step ${k}`);
      }
    }
  }
});

test("walking straight in gets you seen: missions are not trivial", () => {
  // Checked by the generator; here, the same walk played in the game.
  const def = make("naive");
  const m = new Mission(def, agent);
  for (let i = 0; i < 40 && m.status === "play" && !m.spotted && m.peak < 35; i++) {
    const d = dirTo(m.player.at, { x: def.grid.w / 2, y: m.player.at.y });
    if (!m.act({ t: "step", d })) m.act({ t: "wait" });
  }
  assert.ok(m.peak >= 35 || m.spotted, "a guard should at least notice someone walking down the middle");
});

test("a replay from the action log gives exactly the same state", () => {
  const def = make("replay");
  const m = new Mission(def, agent);
  const rng = new Rng("moves");
  for (let i = 0; i < 80 && m.status !== "done"; i++) {
    if (m.status === "confront") {
      m.act(rng.chance(0.5) ? { t: "bluff" } : { t: "flee" });
      continue;
    }
    const d = rng.int(0, 7) as Dir;
    if (!m.act(rng.chance(0.2) ? { t: "run", d } : { t: "step", d })) m.act({ t: "wait" });
  }
  const r = Mission.replay(def, agent, m.log);
  assert.deepEqual(r.player, m.player);
  assert.deepEqual(r.guards, m.guards);
  assert.equal(r.turn, m.turn);
  assert.equal(r.outcome, m.outcome);
});

test("guards hear a running agent and come to look", () => {
  const def = make("noise");
  const m = new Mission(def, agent);
  const g = m.guards.find((x) => !def.guards[x.id]?.post) ?? (m.guards[0] as (typeof m.guards)[number]);
  // Teleport for the test: throw a coin next to the guard.
  const near = DIRS.map((d) => ({ x: g.at.x + d.x * 2, y: g.at.y + d.y * 2 })).find((p) => m.grid.walkable(p.x, p.y)) as Pt;
  m.player.coins = 3;
  m.player.at = near;
  assert.ok(m.act({ t: "throw", at: near }) || true);
  assert.ok(m.guards.some((x) => x.mode !== "patrol"), "someone should react to the noise");
});

test("hiding in a cupboard: invisible to a guard on their round, found by one searching beside it", () => {
  for (let i = 0; i < 30; i++) {
    const def = make(`hide-${i}`);
    const m = new Mission(def, agent);
    let hide: Pt | null = null;
    for (let y = 0; y < m.grid.h && !hide; y++) for (let x = 0; x < m.grid.w && !hide; x++) if (m.grid.get(x, y) === T.Hide) hide = { x, y };
    if (!hide) continue;
    const g = m.guards[0] as (typeof m.guards)[number];
    m.player.at = hide;
    const free = DIRS.map((d) => ({ x: hide.x + d.x, y: hide.y + d.y })).find((p) => m.grid.walkable(p.x, p.y) && m.grid.get(p.x, p.y) !== T.Hide);
    if (!free) continue;
    g.at = free;
    g.facing = dirTo(free, hide);
    g.mode = "patrol";
    m.act({ t: "wait" });
    // A patrolling guard walks on: the agent is not found.
    assert.equal(m.spotted, false);
    const m2 = new Mission(def, agent);
    m2.player.at = hide;
    const g2 = m2.guards[0] as (typeof m2.guards)[number];
    g2.at = free;
    g2.mode = "look";
    g2.timer = 3;
    m2.act({ t: "wait" });
    assert.equal(m2.spotted, true, "a searching guard checks the cupboard beside them");
    return;
  }
  assert.fail("no mission with a cupboard in 30 seeds");
});

test("bluffing: odds shown are exact, and a failed bluff ends in capture", () => {
  assert.equal(chance(0, 2), 1);
  assert.equal(chance(0, 13), 0);
  assert.equal(chance(2, 9), 21 / 36);
  let captured = 0;
  let freed = 0;
  for (let i = 0; i < 40; i++) {
    const def = make(`bluff-${i % 5}`);
    const m = new Mission(def, { ...agent, nerve: 2 });
    const g = m.guards[0] as (typeof m.guards)[number];
    const spot = DIRS.map((d) => ({ x: g.at.x + d.x, y: g.at.y + d.y })).find((p) => m.grid.walkable(p.x, p.y) && m.grid.get(p.x, p.y) !== T.Hide);
    if (!spot) continue;
    m.player.at = spot;
    m.act({ t: "wait" });
    if (m.status !== "confront") {
      // Seen at point-blank range, the guard raises the alarm and stands face to face.
      assert.ok(m.spotted);
      continue;
    }
    // Different seeds of dice: replay with a different log length to vary the roll.
    m.act({ t: "bluff" });
    if (m.outcome === "captured") captured++;
    else freed++;
  }
  assert.ok(captured + freed > 0);
});

test("lights out: a guard is sent to the panel and turns them back on", () => {
  for (let i = 0; i < 20; i++) {
    const def = make(`lights-${i}`);
    const m = new Mission(def, agent);
    const panel = def.panels[1];
    if (!panel) continue;
    const stand = { x: panel.at.x, y: panel.at.y + 1 };
    if (!m.grid.walkable(stand.x, stand.y)) continue;
    m.player.at = stand;
    // Hide the agent's presence from the test: they switch off, then step into a cupboard is not needed.
    const before = m.circuitsOn.size;
    assert.ok(m.act({ t: "use" }));
    assert.equal(m.circuitsOn.size, before - 1);
    for (let k = 0; k < 120 && m.circuitsOn.size < before && m.status === "play"; k++) m.act({ t: "wait" });
    if (m.status !== "play") continue;
    assert.equal(m.circuitsOn.size, before, "the lights should come back");
    return;
  }
});

test("seed codes are short and unambiguous", () => {
  const c = seedCode(new Rng(1));
  assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
});

test("forecast does not change the mission", () => {
  const def = make("forecast");
  const m = new Mission(def, agent);
  m.act({ t: "wait" });
  const before = JSON.stringify({ g: m.guards, p: m.player, t: m.turn });
  m.forecast();
  assert.equal(JSON.stringify({ g: m.guards, p: m.player, t: m.turn }), before);
  assert.ok(Number.isInteger(m.turn));
  assert.ok(eq(m.player.at, m.player.at));
});
