/**
 * The solver's ghost route, played as game actions. Used by the tests (to prove every mission
 * can be done unseen in the game itself) and by the title screen, which replays one behind the menu.
 */
import { dirTo, eq, type Pt } from "./map.js";
import type { Action, Mission } from "./mission.js";
import { PICK_WORST } from "./solver.js";

/** The action that keeps the agent on the ghost route, or null once the route is over. */
export function ghostAction(m: Mission): Action | null {
  const route = m.def.ghost;
  const i = m.turn + 1;
  if (m.status !== "play") return null;
  if (i >= route.length) return m.def.exits.some((e) => eq(e, m.player.at)) ? { t: "leave" } : null;
  const here = m.player.at;
  const next = route[i] as Pt;
  if (!eq(here, next)) return { t: "step", d: dirTo(here, next) };
  let stay = 0;
  while (route[i + stay] && eq(route[i + stay] as Pt, here)) stay++;
  if (m.lockedNear() && stay >= PICK_WORST && !m.player.picked && m.player.pickLeft === 0) return { t: "pick" };
  if (m.useHint() === "photo" && stay >= 2) return { t: "use" };
  return { t: "wait" };
}
