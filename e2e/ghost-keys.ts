// Given a campaign seed, prints the keys that play operation 0 as a ghost with agent `a`.
import { Campaign } from "../src/core/campaign.js";
import { ghostAction } from "../src/core/ghost.js";
import { Mission } from "../src/core/mission.js";

const [seed, agentArg] = process.argv.slice(2);
const c = new Campaign(seed as string);
const agent = c.agents[Number(agentArg ?? 0)];
const op = c.ops[0];
if (!agent || !op) throw new Error("no agent or op");
const m = new Mission(c.missionFor(op), agent);
const DIR = ["ArrowUp", "PageUp", "ArrowRight", "PageDown", "ArrowDown", "End", "ArrowLeft", "Home"];
const keys: string[] = [];
for (let i = 0; i < 2000 && m.status === "play"; i++) {
  const a = ghostAction(m);
  if (!a) break;
  m.act(a);
  keys.push(a.t === "step" ? (DIR[a.d] as string) : a.t === "wait" ? "Space" : a.t === "pick" ? "KeyF" : a.t === "use" ? "KeyE" : a.t === "leave" ? "KeyX" : "?");
}
console.log(JSON.stringify({ keys, outcome: m.outcome, turns: m.turn }));
