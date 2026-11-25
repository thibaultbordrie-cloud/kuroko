/**
 * Draws a mission on a canvas. Logic happens in turns; drawing happens at 60 frames a second:
 * people glide between tiles, cones sweep, light is soft. With reduced motion, everything
 * snaps into place and the rain stops.
 */
import { DIRS, T, type Dir, type Pt } from "../core/map.js";
import type { Event, Mission } from "../core/mission.js";
import type { Site } from "../core/types.js";

interface Palette {
  readonly accent: string;
  readonly glow: string;
  readonly floor: string;
  readonly floor2: string;
  readonly wall: string;
  readonly wallTop: string;
}

export const PALETTES: Record<Site, Palette> = {
  datacenter: { accent: "#38e1ff", glow: "56,225,255", floor: "#121a24", floor2: "#141d28", wall: "#2a3a50", wallTop: "#46607f" },
  consulate: { accent: "#ffb547", glow: "255,181,71", floor: "#1a1714", floor2: "#1d1a16", wall: "#3d342a", wallTop: "#6a5a47" },
  biolab: { accent: "#5cf2b0", glow: "92,242,176", floor: "#111b19", floor2: "#131e1c", wall: "#2a423c", wallTop: "#477066" },
  port: { accent: "#ff8a3d", glow: "255,138,61", floor: "#181614", floor2: "#1b1816", wall: "#3c3129", wallTop: "#6b5444" },
  tower: { accent: "#a98bff", glow: "169,139,255", floor: "#141327", floor2: "#17152b", wall: "#302c52", wallTop: "#544c8a" },
  studio: { accent: "#ff4fb3", glow: "255,79,179", floor: "#1b131d", floor2: "#1e1621", wall: "#3e2841", wallTop: "#6c4470" },
};

/** The agent is always the same cold blue, whatever the building: never confused with a guard. */
const AGENT = "#5fd7ff";

const CONE_CALM = [255, 236, 170];
const CONE_DOUBT = [255, 160, 60];
const CONE_ALERT = [255, 64, 64];

interface Sprite {
  x: number;
  y: number;
  a: number;
  bob: number;
}

interface Ring {
  x: number;
  y: number;
  max: number;
  t0: number;
  color: string;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private m: Mission | null = null;
  private pal: Palette = PALETTES.datacenter;
  ts = 28;
  private cam = { x: 0, y: 0 };
  private player: Sprite = { x: 0, y: 0, a: 0, bob: 0 };
  private guards = new Map<number, Sprite>();
  private rings: Ring[] = [];
  private pops = new Map<number, number>();
  private staticLayer: HTMLCanvasElement | null = null;
  private lightLayer = document.createElement("canvas");
  private coneLayer = document.createElement("canvas");
  private forecastLayer = document.createElement("canvas");
  private cones = new Map<number, number[]>();
  private forecast: Map<number, number[]> | null = null;
  private drops: { x: number; y: number; v: number }[] = [];
  private last = 0;
  reduced = false;
  /** Tiles to highlight: the path the player hovers, or the targets of a lure. */
  preview: Pt[] = [];
  targets: Pt[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const c = canvas.getContext("2d", { alpha: false });
    if (!c) throw new Error("no 2D canvas");
    this.ctx = c;
    for (let i = 0; i < 140; i++) this.drops.push({ x: Math.random(), y: Math.random(), v: 0.6 + Math.random() * 0.6 });
  }

  setMission(m: Mission): void {
    this.m = m;
    this.pal = PALETTES[m.def.site];
    this.player = { x: m.player.at.x, y: m.player.at.y, a: angle(m.player.facing), bob: 0 };
    this.guards.clear();
    for (const g of m.guards) this.guards.set(g.id, { x: g.at.x, y: g.at.y, a: angle(g.facing), bob: 0 });
    this.cam = { x: m.player.at.x, y: m.player.at.y };
    this.rings = [];
    this.staticLayer = null;
    this.refresh(null);
  }

  /** After each turn: new cones, new light, effects for what happened. */
  refresh(events: readonly Event[] | null, plan = false): void {
    const m = this.m;
    if (!m) return;
    this.cones = m.status === "done" ? new Map() : m.cones();
    this.forecast = plan && m.status === "play" ? m.forecast() : null;
    this.paintLight();
    this.paintCones(this.coneLayer, this.cones);
    if (this.forecast) this.paintCones(this.forecastLayer, this.forecast);
    const now = performance.now();
    for (const e of events ?? []) {
      if (e.k === "noise") this.rings.push({ x: e.at.x, y: e.at.y, max: e.loud, t0: now, color: "255,255,255" });
      if (e.k === "notice" || e.k === "spotted" || e.k === "radio" || e.k === "found") this.pops.set(e.guard, now);
      if (e.k === "unlock") this.staticLayer = null;
    }
    if (this.reduced) this.snap();
  }

  private snap(): void {
    const m = this.m as Mission;
    this.player.x = m.player.at.x;
    this.player.y = m.player.at.y;
    this.player.a = angle(m.player.facing);
    for (const g of m.guards) {
      const s = this.guards.get(g.id);
      if (s) Object.assign(s, { x: g.at.x, y: g.at.y, a: angle(g.facing) });
    }
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m = this.m;
    if (m) {
      // Whole building on a large screen; a closer, following view on a phone.
      const fit = Math.min(r.width / (m.grid.w + 1), r.height / (m.grid.h + 1));
      this.ts = Math.max(22, Math.min(44, Math.floor(fit)));
    }
    this.staticLayer = null;
  }

  /** The tile under a point of the canvas. */
  tileAt(px: number, py: number): Pt {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((px - r.width / 2) / this.ts + this.cam.x + 0.5);
    const y = Math.floor((py - r.height / 2) / this.ts + this.cam.y + 0.5);
    return { x, y };
  }

  // ---------- Offscreen layers ----------

  private paintLight(): void {
    const m = this.m as Mission;
    const g = m.grid;
    this.lightLayer.width = g.w;
    this.lightLayer.height = g.h;
    const c = this.lightLayer.getContext("2d") as CanvasRenderingContext2D;
    const img = c.createImageData(g.w, g.h);
    for (let i = 0; i < g.w * g.h; i++) {
      const lvl = m.light[i] as number;
      img.data[i * 4 + 0] = 4;
      img.data[i * 4 + 1] = 6;
      img.data[i * 4 + 2] = 14;
      img.data[i * 4 + 3] = lvl === 2 ? 0 : lvl === 1 ? 80 : 160;
    }
    c.putImageData(img, 0, 0);
  }

  private paintCones(layer: HTMLCanvasElement, cones: Map<number, number[]>): void {
    const m = this.m as Mission;
    const g = m.grid;
    layer.width = g.w;
    layer.height = g.h;
    const c = layer.getContext("2d") as CanvasRenderingContext2D;
    const img = c.createImageData(g.w, g.h);
    for (const guard of m.guards) {
      const col = guard.mode === "alert" ? CONE_ALERT : guard.mode === "patrol" || guard.mode === "return" || guard.mode === "fix" ? CONE_CALM : CONE_DOUBT;
      for (const i of cones.get(guard.id) ?? []) {
        img.data[i * 4] = col[0] as number;
        img.data[i * 4 + 1] = col[1] as number;
        img.data[i * 4 + 2] = col[2] as number;
        img.data[i * 4 + 3] = guard.mode === "alert" ? 120 : 80;
      }
    }
    c.putImageData(img, 0, 0);
  }

  private buildStatic(): HTMLCanvasElement {
    const m = this.m as Mission;
    const g = m.grid;
    const ts = this.ts;
    const cv = document.createElement("canvas");
    cv.width = g.w * ts;
    cv.height = g.h * ts;
    const c = cv.getContext("2d") as CanvasRenderingContext2D;
    const p = this.pal;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const t = g.get(x, y);
        const px = x * ts;
        const py = y * ts;
        if (t === T.Void) {
          c.fillStyle = "#05070b";
          c.fillRect(px, py, ts, ts);
          continue;
        }
        if (t === T.Wall || t === T.Window) {
          c.fillStyle = p.wall;
          c.fillRect(px, py, ts, ts);
          const open = (dx: number, dy: number) => {
            const n = g.get(x + dx, y + dy);
            return n !== T.Wall && n !== T.Void && n !== T.Window;
          };
          // The top of the wall catches the light; its faces toward rooms get a hard edge.
          c.fillStyle = p.wallTop;
          if (open(0, -1)) c.fillRect(px, py, ts, 2);
          if (open(0, 1)) {
            c.fillRect(px, py + ts * 0.7, ts, ts * 0.3);
            c.fillStyle = "rgba(0,0,0,0.5)";
            c.fillRect(px, py + ts - 1, ts, 1);
          }
          c.fillStyle = p.wallTop;
          if (open(-1, 0)) c.fillRect(px, py, 2, ts);
          if (open(1, 0)) c.fillRect(px + ts - 2, py, 2, ts);
          if (t === T.Window) {
            c.fillStyle = `rgba(${p.glow},0.35)`;
            c.fillRect(px + ts * 0.15, py + ts * 0.4, ts * 0.7, ts * 0.2);
          }
          continue;
        }
        c.fillStyle = (x + y) % 2 === 0 ? p.floor : p.floor2;
        c.fillRect(px, py, ts, ts);
        c.fillStyle = "rgba(255,255,255,0.025)";
        c.fillRect(px, py, ts, 1);
        c.fillRect(px, py, 1, ts);
        if (g.room(x, y) === 0) {
          c.fillStyle = "rgba(255,255,255,0.025)";
          c.fillRect(px, py + ts * 0.45, ts, ts * 0.1);
        }
        switch (t) {
          case T.Furniture: {
            c.fillStyle = "#2b3440";
            roundRect(c, px + ts * 0.1, py + ts * 0.2, ts * 0.8, ts * 0.6, ts * 0.08);
            c.fillStyle = `rgba(${p.glow},0.3)`;
            c.fillRect(px + ts * 0.3, py + ts * 0.3, ts * 0.4, ts * 0.12);
            break;
          }
          case T.Tall: {
            c.fillStyle = "#1f2630";
            c.fillRect(px + ts * 0.08, py + ts * 0.04, ts * 0.84, ts * 0.92);
            c.fillStyle = "#11161d";
            for (let k = 0; k < 4; k++) c.fillRect(px + ts * 0.14, py + ts * (0.12 + k * 0.2), ts * 0.72, ts * 0.12);
            break;
          }
          case T.Hide: {
            c.fillStyle = "#3a4250";
            c.fillRect(px + ts * 0.12, py + ts * 0.06, ts * 0.76, ts * 0.88);
            c.strokeStyle = "#5a6476";
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(px + ts * 0.5, py + ts * 0.1);
            c.lineTo(px + ts * 0.5, py + ts * 0.9);
            for (let k = 0; k < 3; k++) {
              c.moveTo(px + ts * 0.2, py + ts * (0.2 + k * 0.06));
              c.lineTo(px + ts * 0.42, py + ts * (0.2 + k * 0.06));
            }
            c.stroke();
            break;
          }
          case T.Door:
          case T.Locked: {
            c.fillStyle = "#2d3440";
            const vertical = g.walkable(x, y - 1) || g.walkable(x, y + 1);
            if (vertical) c.fillRect(px + ts * 0.42, py, ts * 0.16, ts);
            else c.fillRect(px, py + ts * 0.42, ts, ts * 0.16);
            if (t === T.Locked) {
              c.fillStyle = "#ff3b47";
              c.beginPath();
              c.arc(px + ts * 0.5, py + ts * 0.5, ts * 0.1, 0, Math.PI * 2);
              c.fill();
            }
            break;
          }
          case T.Exit: {
            c.fillStyle = "#103a24";
            c.fillRect(px, py, ts, ts);
            break;
          }
          default:
            break;
        }
      }
    }
    return cv;
  }

  // ---------- The frame ----------

  frame(now: number): void {
    const m = this.m;
    const ctx = this.ctx;
    const r = this.canvas.getBoundingClientRect();
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    ctx.fillStyle = "#05070b";
    ctx.fillRect(0, 0, r.width, r.height);
    if (!m) return;
    const k = this.reduced ? 1 : 1 - Math.exp(-dt / 0.07);
    const kc = this.reduced ? 1 : 1 - Math.exp(-dt / 0.25);

    // Glide everyone toward where they are.
    const glide = (s: Sprite, at: Pt, facing: Dir) => {
      const dx = at.x - s.x;
      const dy = at.y - s.y;
      s.bob += Math.hypot(dx, dy) * k * 9;
      s.x += dx * k;
      s.y += dy * k;
      let da = angle(facing) - s.a;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      s.a += da * k;
    };
    glide(this.player, m.player.at, m.player.facing);
    for (const g of m.guards) {
      const s = this.guards.get(g.id);
      if (s) glide(s, g.at, g.facing);
    }
    // The camera follows the agent unless the whole building fits.
    const fitsX = m.grid.w * this.ts <= r.width;
    const fitsY = m.grid.h * this.ts <= r.height;
    const tx = fitsX ? (m.grid.w - 1) / 2 : clamp(this.player.x, r.width / 2 / this.ts - 0.5, m.grid.w - r.width / 2 / this.ts - 0.5);
    const ty = fitsY ? (m.grid.h - 1) / 2 : clamp(this.player.y, r.height / 2 / this.ts - 0.5, m.grid.h - r.height / 2 / this.ts - 0.5);
    this.cam.x += (tx - this.cam.x) * kc;
    this.cam.y += (ty - this.cam.y) * kc;

    const ts = this.ts;
    const ox = r.width / 2 - (this.cam.x + 0.5) * ts;
    const oy = r.height / 2 - (this.cam.y + 0.5) * ts;
    const sx = (x: number) => ox + (x + 0.5) * ts;
    const sy = (y: number) => oy + (y + 0.5) * ts;

    if (!this.staticLayer) this.staticLayer = this.buildStatic();
    ctx.drawImage(this.staticLayer, ox, oy);

    // Lamp glows, added light.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const l of m.def.lamps) {
      if (!m.circuitsOn.has(l.circuit)) continue;
      const cx = sx(l.at.x);
      const cy = sy(l.at.y);
      const flick = this.reduced ? 1 : 0.92 + 0.08 * Math.sin(now / 370 + l.at.x * 3.1);
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, l.radius * ts);
      grd.addColorStop(0, `rgba(${this.pal.glow},${0.16 * flick})`);
      grd.addColorStop(1, `rgba(${this.pal.glow},0)`);
      ctx.fillStyle = grd;
      ctx.fillRect(cx - l.radius * ts, cy - l.radius * ts, l.radius * ts * 2, l.radius * ts * 2);
    }
    ctx.restore();

    // Darkness, softened by scaling a one-pixel-per-tile image.
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.lightLayer, ox, oy, m.grid.w * ts, m.grid.h * ts);
    ctx.restore();

    // Objects.
    for (const it of m.def.items) {
      const cx = sx(it.at.x);
      const cy = sy(it.at.y);
      if (it.kind === "document" && !m.player.photo) {
        const pulse = this.reduced ? 0.6 : 0.5 + 0.5 * Math.sin(now / 300);
        ctx.strokeStyle = this.pal.accent;
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.lineWidth = 2;
        diamond(ctx, cx, cy, ts * (0.32 + 0.06 * pulse));
        ctx.globalAlpha = 1;
      } else if (it.kind === "key" && !m.player.key) {
        ctx.fillStyle = "#e8edf5";
        roundRect(ctx, cx - ts * 0.18, cy - ts * 0.12, ts * 0.36, ts * 0.24, 3);
        ctx.fillStyle = this.pal.accent;
        ctx.fillRect(cx - ts * 0.12, cy - ts * 0.04, ts * 0.1, ts * 0.08);
      } else if (it.kind === "panel") {
        const on = m.circuitsOn.has(it.circuit ?? 0);
        ctx.fillStyle = "#39414e";
        ctx.fillRect(cx - ts * 0.28, cy - ts * 0.05, ts * 0.56, ts * 0.42);
        ctx.fillStyle = on ? "#3dff8b" : "#ff3b47";
        ctx.beginPath();
        ctx.arc(cx, cy + ts * 0.16, ts * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const e of m.def.exits) {
      const cx = sx(e.x);
      const cy = sy(e.y);
      const phase = this.reduced ? 0 : (now / 600) % 1;
      ctx.strokeStyle = `rgba(61,255,139,${0.4 + 0.4 * (1 - phase)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - ts * 0.4, cy - ts * 0.4, ts * 0.8, ts * 0.8);
    }

    // Sight cones, soft.
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.coneLayer, ox, oy, m.grid.w * ts, m.grid.h * ts);
    if (this.forecast) {
      ctx.globalAlpha = 0.55 + (this.reduced ? 0 : 0.25 * Math.sin(now / 250));
      ctx.drawImage(this.forecastLayer, ox, oy, m.grid.w * ts, m.grid.h * ts);
      ctx.globalAlpha = 1;
      // The forecast is outlined too: not colour alone.
      ctx.strokeStyle = "rgba(255,236,170,0.5)";
      ctx.setLineDash([3, 3]);
      for (const tiles of this.forecast.values()) {
        for (const i of tiles) ctx.strokeRect(ox + (i % m.grid.w) * ts + 2, oy + Math.floor(i / m.grid.w) * ts + 2, ts - 4, ts - 4);
      }
      ctx.setLineDash([]);
    }
    ctx.restore();

    // Path preview and lure targets.
    for (const p of this.preview) {
      ctx.fillStyle = "rgba(56,225,255,0.35)";
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), ts * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const p of this.targets) {
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.strokeRect(sx(p.x) - ts * 0.4, sy(p.y) - ts * 0.4, ts * 0.8, ts * 0.8);
    }

    // The agent.
    const hidden = m.hidden();
    const ax = sx(this.player.x);
    const ay = sy(this.player.y);
    const breathe = this.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(now / 420);
    const halo = ctx.createRadialGradient(ax, ay, 0, ax, ay, ts * 1.1);
    halo.addColorStop(0, `rgba(95,215,255,${0.22 + 0.1 * breathe})`);
    halo.addColorStop(1, "rgba(95,215,255,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(ax - ts * 1.1, ay - ts * 1.1, ts * 2.2, ts * 2.2);
    ctx.strokeStyle = AGENT;
    ctx.globalAlpha = 0.5 + 0.3 * breathe;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ax, ay, ts * 0.48, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    this.person(ax, ay, this.player, "#0b0f15", AGENT, hidden ? 0.4 : 1, false);

    // Guards.
    for (const g of m.guards) {
      const s = this.guards.get(g.id);
      if (!s) continue;
      const gx = sx(s.x);
      const gy = sy(s.y);
      const color = g.mode === "alert" ? "#ff4040" : g.mode === "patrol" || g.mode === "return" || g.mode === "fix" ? "#ffe9a8" : "#ffa03c";
      this.person(gx, gy, s, "#2a2f3a", color, 1, true);
      // Suspicion as an arc around the guard.
      if (g.suspicion > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(gx, gy, ts * 0.46, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * g.suspicion) / 100);
        ctx.stroke();
      }
      // "?" or "!" above the head: the state in a shape, not only a colour.
      const mark = g.mode === "alert" ? "!" : g.mode === "patrol" || g.mode === "return" || g.mode === "fix" ? "" : "?";
      if (mark) {
        const t0 = this.pops.get(g.id) ?? 0;
        const pop = this.reduced ? 1 : Math.min(1, (now - t0) / 180);
        const scale = 0.6 + 0.4 * easeOutBack(pop);
        ctx.font = `700 ${Math.round(ts * 0.62 * scale)}px "Chakra Petch", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = color;
        ctx.fillText(mark, gx, gy - ts * 0.45);
      }
    }

    // Noise rings.
    this.rings = this.rings.filter((rg) => now - rg.t0 < 900);
    for (const rg of this.rings) {
      const p = (now - rg.t0) / 900;
      ctx.strokeStyle = `rgba(${rg.color},${0.5 * (1 - p)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx(rg.x), sy(rg.y), Math.max(1, rg.max * ts * (this.reduced ? 1 : easeOut(p))), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Rain on the glass, and a vignette.
    if (!this.reduced) {
      ctx.strokeStyle = "rgba(170,200,255,0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of this.drops) {
        d.y += d.v * dt * 1.4;
        d.x += d.v * dt * 0.25;
        if (d.y > 1) {
          d.y -= 1;
          d.x = Math.random();
        }
        if (d.x > 1) d.x -= 1;
        const x = d.x * r.width;
        const y = d.y * r.height;
        ctx.moveTo(x, y);
        ctx.lineTo(x + 3, y + 12);
      }
      ctx.stroke();
    }
    const vg = ctx.createRadialGradient(r.width / 2, r.height / 2, Math.min(r.width, r.height) * 0.35, r.width / 2, r.height / 2, Math.max(r.width, r.height) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, r.width, r.height);
  }

  /** A person seen from above: shoulders, head, and for guards a torch beam. */
  private person(x: number, y: number, s: Sprite, body: string, rim: string, alpha: number, torch: boolean): void {
    const ctx = this.ctx;
    const ts = this.ts;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.ellipse(0, ts * 0.12, ts * 0.32, ts * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(s.a);
    const sway = this.reduced ? 0 : Math.sin(s.bob) * ts * 0.04;
    if (torch) {
      const grd = ctx.createLinearGradient(0, 0, ts * 1.6, 0);
      grd.addColorStop(0, "rgba(255,240,190,0.35)");
      grd.addColorStop(1, "rgba(255,240,190,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(ts * 0.2, 0);
      ctx.lineTo(ts * 1.6, -ts * 0.5);
      ctx.lineTo(ts * 1.6, ts * 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = body;
    ctx.strokeStyle = rim;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, sway, ts * 0.2, ts * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ts * 0.08, sway, ts * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = rim;
    ctx.fill();
    ctx.restore();
  }
}

function angle(d: Dir): number {
  const v = DIRS[d] as Pt;
  return Math.atan2(v.y, v.x);
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, v));
}

function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}

function easeOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
  c.fill();
}

function diamond(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath();
  c.moveTo(x, y - r);
  c.lineTo(x + r, y);
  c.lineTo(x, y + r);
  c.lineTo(x - r, y);
  c.closePath();
  c.stroke();
}
