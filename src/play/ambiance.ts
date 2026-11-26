/**
 * The world around the words: a painted plate for each place and a sound bed under it.
 * Everything is drawn and synthesised here, from the place name; nothing is downloaded.
 */
import { hash128 } from "../core/rng.js";

export type Kind = "street" | "train" | "room" | "port" | "river" | "shrine" | "high" | "bath" | "office";

const KEYWORDS: [Kind, RegExp][] = [
  ["train", /gare|ligne|train|tram|metro|quai|wagon|tunnel/],
  ["port", /port|terminal|entrepot|conteneur|dock/],
  ["river", /riviere|fleuve|berge|pont|canal/],
  ["shrine", /sanctuaire|temple|torii/],
  ["high", /bar|hotel|etage|tour|toit/],
  ["bath", /bain|onsen|sento/],
  ["office", /bureau|commissariat|agence|dossier|journal/],
  ["room", /chambre|cuisine|appartement|salon|maison/],
  ["street", /.*/],
]

const MOOD_KIND: Record<string, Kind> = { rue: "street", train: "train", chambre: "room", port: "port", riviere: "river", sanctuaire: "shrine", hauteur: "high", bain: "bath", bureau: "office" };

export function kindOf(place: string, mood = ""): Kind {
  const m = MOOD_KIND[mood];
  if (m) return m;
  const p = place.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [k, re] of KEYWORDS) if (re.test(p)) return k;
  return "street";
}

/** A small seeded generator so the same place always looks the same. */
function rand(seed: string): () => number {
  let [a, b, c, d] = hash128(seed);
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
}

const NEON = ["#ff3d7f", "#3ee8ff", "#ffb347", "#b26bff", "#5dff9e", "#ff6a3d"];
const SIGNS = ["薬", "酒", "喫茶", "天満", "質", "麺", "鍵", "湯", "宿", "占", "夜", "鮨"];

function skyline(g: CanvasRenderingContext2D, w: number, h: number, base: number, r: () => number, dark: string, windows = 0.08): void {
  let x = -10;
  while (x < w + 10) {
    const bw = 18 + r() * 46;
    const bh = h * (0.12 + r() * 0.38);
    g.fillStyle = dark;
    g.fillRect(x, base - bh, bw, bh + 2);
    for (let wy = base - bh + 6; wy < base - 6; wy += 7) {
      for (let wx = x + 4; wx < x + bw - 4; wx += 6) {
        if (r() < windows) {
          g.fillStyle = r() < 0.8 ? "rgba(255,205,130,0.75)" : "rgba(150,210,255,0.7)";
          g.fillRect(wx, wy, 2.5, 3);
        }
      }
    }
    if (r() < 0.25) {
      g.fillStyle = "#ff3030";
      g.fillRect(x + bw / 2, base - bh - 3, 2, 2);
    }
    x += bw + r() * 6;
  }
}

function sky(g: CanvasRenderingContext2D, w: number, h: number, top: string, bottom: string): void {
  const sg = g.createLinearGradient(0, 0, 0, h);
  sg.addColorStop(0, top);
  sg.addColorStop(1, bottom);
  g.fillStyle = sg;
  g.fillRect(0, 0, w, h);
}

function glowText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, vertical: boolean): void {
  g.save();
  g.font = `700 ${size}px "Hiragino Sans","Noto Sans CJK JP","Yu Gothic",sans-serif`;
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = size * 0.8;
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (vertical) [...text].forEach((ch, i) => g.fillText(ch, x, y + i * size * 1.05));
  else g.fillText(text, x, y);
  g.restore();
}

function reflections(g: CanvasRenderingContext2D, w: number, top: number, h: number, r: () => number, n: number): void {
  for (let i = 0; i < n; i++) {
    const x = r() * w;
    const c = NEON[Math.floor(r() * NEON.length)] as string;
    const grd = g.createLinearGradient(0, top, 0, h);
    grd.addColorStop(0, c + "88");
    grd.addColorStop(1, c + "00");
    g.fillStyle = grd;
    g.fillRect(x, top, 2 + r() * 6, h - top);
  }
}

/** The still part of a plate, drawn once per scene. */
function paintStatic(g: CanvasRenderingContext2D, w: number, h: number, kind: Kind, r: () => number): void {
  switch (kind) {
    case "street": {
      sky(g, w, h, "#05060c", "#2a1530");
      skyline(g, w, h, h * 0.62, r, "#0b0d18", 0.1);
      // Facades on both sides with vertical signs.
      for (const side of [0, 1]) {
        const x0 = side ? w * 0.78 : 0;
        g.fillStyle = "#07080e";
        g.fillRect(x0, 0, w * 0.22, h);
        for (let k = 0; k < 3; k++) {
          const sx = x0 + w * (0.05 + k * 0.06);
          const sign = SIGNS[Math.floor(r() * SIGNS.length)] as string;
          const col = NEON[Math.floor(r() * NEON.length)] as string;
          g.fillStyle = "#111";
          g.fillRect(sx - 12, h * 0.12 + k * 14, 24, sign.length * 24 + 12);
          glowText(g, sign, sx, h * 0.12 + k * 14 + 18, 18, col, true);
        }
      }
      // Wet road.
      const rg = g.createLinearGradient(0, h * 0.62, 0, h);
      rg.addColorStop(0, "#14101c");
      rg.addColorStop(1, "#050508");
      g.fillStyle = rg;
      g.fillRect(0, h * 0.62, w, h * 0.38);
      reflections(g, w, h * 0.62, h, r, 14);
      break;
    }
    case "train": {
      sky(g, w, h, "#0a0c12", "#12151d");
      for (let i = 0; i < 3; i++) {
        const x = w * (0.08 + i * 0.31);
        g.fillStyle = "#060810";
        g.beginPath();
        g.roundRect(x, h * 0.18, w * 0.26, h * 0.42, 10);
        g.fill();
        g.save();
        g.clip();
        for (let k = 0; k < 9; k++) {
          g.fillStyle = (NEON[Math.floor(r() * NEON.length)] as string) + "aa";
          g.fillRect(x - 20 + r() * w * 0.3, h * (0.22 + r() * 0.34), 30 + r() * 90, 1.5);
        }
        g.restore();
        g.strokeStyle = "#2a2f3c";
        g.lineWidth = 3;
        g.stroke();
      }
      g.strokeStyle = "#3a3f4c";
      g.lineWidth = 2;
      for (let i = 0; i < 7; i++) {
        const x = w * (0.1 + i * 0.13);
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h * 0.09);
        g.stroke();
        g.beginPath();
        g.arc(x, h * 0.12, 7, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = "#1c2230";
      g.fillRect(0, h * 0.74, w, h * 0.26);
      g.fillStyle = "#3b2a2a";
      g.fillRect(0, h * 0.7, w, h * 0.06);
      break;
    }
    case "room": {
      sky(g, w, h, "#0e0c10", "#17121a");
      const wx = w * 0.3;
      const ww = w * 0.4;
      const wy = h * 0.12;
      const wh = h * 0.6;
      const inside = g.createLinearGradient(0, wy, 0, wy + wh);
      inside.addColorStop(0, "#0a1020");
      inside.addColorStop(1, "#2b1730");
      g.fillStyle = inside;
      g.fillRect(wx, wy, ww, wh);
      g.save();
      g.beginPath();
      g.rect(wx, wy, ww, wh);
      g.clip();
      skyline(g, w, h, wy + wh, r, "#0b0d18", 0.12);
      for (let i = 0; i < 18; i++) {
        const c = NEON[Math.floor(r() * NEON.length)] as string;
        const bx = wx + r() * ww;
        const by = wy + wh * (0.4 + r() * 0.6);
        const rad = 4 + r() * 14;
        const bg = g.createRadialGradient(bx, by, 0, bx, by, rad);
        bg.addColorStop(0, c + "66");
        bg.addColorStop(1, c + "00");
        g.fillStyle = bg;
        g.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
      }
      g.restore();
      g.strokeStyle = "#2d2630";
      g.lineWidth = 6;
      g.strokeRect(wx, wy, ww, wh);
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(wx + ww / 2, wy);
      g.lineTo(wx + ww / 2, wy + wh);
      g.stroke();
      const lamp = g.createRadialGradient(w * 0.1, h * 0.85, 0, w * 0.1, h * 0.85, w * 0.35);
      lamp.addColorStop(0, "rgba(255,180,100,0.35)");
      lamp.addColorStop(1, "rgba(255,180,100,0)");
      g.fillStyle = lamp;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#0b090c";
      g.fillRect(0, h * 0.86, w, h * 0.14);
      break;
    }
    case "port": {
      sky(g, w, h, "#04070d", "#1a2030");
      skyline(g, w, h, h * 0.58, r, "#0a0e18", 0.04);
      for (let i = 0; i < 4; i++) {
        const cx = w * (0.1 + i * 0.25 + r() * 0.05);
        g.strokeStyle = "#1b2130";
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(cx, h * 0.58);
        g.lineTo(cx, h * 0.15);
        g.lineTo(cx + w * 0.14, h * 0.15);
        g.moveTo(cx - w * 0.04, h * 0.15);
        g.lineTo(cx, h * 0.15);
        g.stroke();
        g.fillStyle = "#ff3030";
        g.fillRect(cx - 1, h * 0.14 - 3, 3, 3);
      }
      const cols = ["#5a2a24", "#24405a", "#2f4a2a", "#5a4a24"];
      for (let i = 0; i < 26; i++) {
        g.fillStyle = cols[Math.floor(r() * cols.length)] as string;
        const bx = r() * w;
        const lvl = Math.floor(r() * 3);
        g.fillRect(bx, h * 0.58 - (lvl + 1) * 12, 36, 11);
      }
      const wg = g.createLinearGradient(0, h * 0.6, 0, h);
      wg.addColorStop(0, "#0d1422");
      wg.addColorStop(1, "#03050a");
      g.fillStyle = wg;
      g.fillRect(0, h * 0.6, w, h * 0.4);
      reflections(g, w, h * 0.6, h, r, 10);
      break;
    }
    case "river": {
      sky(g, w, h, "#05070f", "#22182c");
      skyline(g, w, h, h * 0.5, r, "#0b0d18", 0.09);
      g.strokeStyle = "#141824";
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(0, h * 0.42);
      g.quadraticCurveTo(w / 2, h * 0.32, w, h * 0.42);
      g.stroke();
      for (let i = 0; i < 24; i++) {
        const t = i / 23;
        const x = t * w;
        const y = h * 0.42 - Math.sin(t * Math.PI) * h * 0.1;
        g.fillStyle = "rgba(255,220,150,0.9)";
        g.fillRect(x, y - 3, 2, 2);
      }
      const wg = g.createLinearGradient(0, h * 0.5, 0, h);
      wg.addColorStop(0, "#0c1020");
      wg.addColorStop(1, "#020306");
      g.fillStyle = wg;
      g.fillRect(0, h * 0.5, w, h * 0.5);
      reflections(g, w, h * 0.5, h, r, 18);
      break;
    }
    case "shrine": {
      sky(g, w, h, "#070609", "#1d0f12");
      g.fillStyle = "#0e0809";
      g.fillRect(0, h * 0.78, w, h * 0.22);
      const tx = w * 0.5;
      g.fillStyle = "#3a0d0d";
      g.fillRect(tx - w * 0.22, h * 0.16, w * 0.44, 10);
      g.fillRect(tx - w * 0.19, h * 0.25, w * 0.38, 7);
      g.fillRect(tx - w * 0.15, h * 0.16, 9, h * 0.62);
      g.fillRect(tx + w * 0.15 - 9, h * 0.16, 9, h * 0.62);
      for (let i = 0; i < 6; i++) {
        const lx = w * (0.08 + i * 0.17);
        const lg = g.createRadialGradient(lx, h * 0.45, 0, lx, h * 0.45, 40);
        lg.addColorStop(0, "rgba(255,120,60,0.55)");
        lg.addColorStop(1, "rgba(255,120,60,0)");
        g.fillStyle = lg;
        g.fillRect(lx - 40, h * 0.45 - 40, 80, 80);
        g.fillStyle = "#ff8a4a";
        g.beginPath();
        g.ellipse(lx, h * 0.45, 7, 10, 0, 0, Math.PI * 2);
        g.fill();
      }
      for (let i = 0; i < 40; i++) {
        g.fillStyle = r() < 0.15 ? "#e8dcc0" : "#7a5a3a";
        g.fillRect(w * 0.05 + (i % 20) * w * 0.045, h * (0.66 + Math.floor(i / 20) * 0.06), w * 0.03, h * 0.04);
      }
      break;
    }
    case "high": {
      sky(g, w, h, "#04050b", "#2b1020");
      skyline(g, w, h, h * 0.92, r, "#0a0c16", 0.16);
      skyline(g, w, h, h, r, "#06070d", 0.08);
      g.strokeStyle = "#1c1c24";
      g.lineWidth = 8;
      g.strokeRect(4, 4, w - 8, h - 8);
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(w * 0.5, 0);
      g.lineTo(w * 0.5, h);
      g.stroke();
      break;
    }
    case "bath": {
      sky(g, w, h, "#16242c", "#0c1418");
      g.fillStyle = "#2f5878";
      g.beginPath();
      g.moveTo(w * 0.2, h * 0.55);
      g.lineTo(w * 0.5, h * 0.12);
      g.lineTo(w * 0.8, h * 0.55);
      g.fill();
      g.fillStyle = "#e6edf0";
      g.beginPath();
      g.moveTo(w * 0.42, h * 0.24);
      g.lineTo(w * 0.5, h * 0.12);
      g.lineTo(w * 0.58, h * 0.24);
      g.fill();
      g.strokeStyle = "rgba(200,220,230,0.08)";
      g.lineWidth = 1;
      for (let y = h * 0.6; y < h; y += 12) {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
      }
      for (let x = 0; x < w; x += 12) {
        g.beginPath();
        g.moveTo(x, h * 0.6);
        g.lineTo(x, h);
        g.stroke();
      }
      break;
    }
    case "office": {
      sky(g, w, h, "#0b0e12", "#12161c");
      g.fillStyle = "rgba(220,240,255,0.18)";
      g.fillRect(w * 0.2, h * 0.04, w * 0.6, 6);
      for (let y = h * 0.14; y < h * 0.7; y += 9) {
        g.fillStyle = "rgba(160,190,220,0.12)";
        g.fillRect(w * 0.1, y, w * 0.8, 4);
      }
      g.fillStyle = "#07090c";
      g.fillRect(0, h * 0.74, w, h * 0.26);
      g.fillStyle = "rgba(120,200,255,0.35)";
      g.fillRect(w * 0.55, h * 0.6, w * 0.16, h * 0.12);
      break;
    }
  }
  // A vignette ties every plate to the page.
  const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.75);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.75)");
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
}

/** A living plate: the still image, then rain and a breathing neon over it, every frame. */
export class Plate {
  private still = document.createElement("canvas");
  private drops: { x: number; y: number; v: number; l: number }[] = [];
  private raf = 0;
  private alive = true;
  private glass: number[][] | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly kind: Kind, seed: string, reduced: boolean, private readonly cold: boolean) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width || 360));
    const h = Math.max(160, Math.round(rect.height || 200));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    this.still.width = w * dpr;
    this.still.height = h * dpr;
    const g = this.still.getContext("2d") as CanvasRenderingContext2D;
    g.scale(dpr, dpr);
    paintStatic(g, w, h, kind, rand(seed));
    if (cold) {
      g.globalCompositeOperation = "color";
      g.fillStyle = "rgba(70,150,255,0.55)";
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = "source-over";
    }
    // Indoors, the rain only shows through the glass.
    this.glass = kind === "room" ? [[0.3, 0.12, 0.4, 0.6]] : kind === "train" ? [0, 1, 2].map((i) => [0.08 + i * 0.31, 0.18, 0.26, 0.42]) : kind === "office" || kind === "bath" ? [] : null;
    const n = this.glass && this.glass.length === 0 ? 0 : this.glass ? 70 : 140;
    const r = rand(seed + "/rain");
    for (let i = 0; i < n; i++) this.drops.push({ x: r() * w, y: r() * h, v: 260 + r() * 240, l: 8 + r() * 14 });
    this.draw(0, 0);
    if (!reduced) {
      let last = performance.now();
      const tick = (now: number) => {
        if (!this.alive || !this.canvas.isConnected) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        this.draw(now / 1000, dt);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  stop(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
  }

  private draw(t: number, dt: number): void {
    const g = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    const dpr = this.canvas.width / (this.canvas.getBoundingClientRect().width || this.canvas.width);
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.still, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = w / dpr;
    const ch = h / dpr;
    // Neon breathes and sometimes fails for a blink.
    const flicker = Math.sin(t * 2.1) * 0.5 + 0.5;
    const fail = Math.sin(t * 13.7) > 0.985 ? 0.25 : 1;
    g.globalCompositeOperation = "lighter";
    g.fillStyle = `rgba(255,60,140,${0.04 * flicker * fail})`;
    g.fillRect(0, 0, cw, ch);
    g.globalCompositeOperation = "source-over";
    if (this.kind === "bath") {
      const steam = g.createLinearGradient(0, ch, 0, 0);
      steam.addColorStop(0, `rgba(230,240,245,${0.22 + 0.06 * Math.sin(t * 0.7)})`);
      steam.addColorStop(1, "rgba(230,240,245,0)");
      g.fillStyle = steam;
      g.fillRect(0, 0, cw, ch);
    }
    if (this.glass) {
      g.save();
      g.beginPath();
      for (const r of this.glass) g.rect((r[0] ?? 0) * cw, (r[1] ?? 0) * ch, (r[2] ?? 0) * cw, (r[3] ?? 0) * ch);
      g.clip();
    }
    g.strokeStyle = this.cold ? "rgba(170,210,255,0.28)" : "rgba(190,200,230,0.22)";
    g.lineWidth = 1;
    g.beginPath();
    for (const d of this.drops) {
      d.y += d.v * dt;
      d.x += d.v * dt * 0.12;
      if (d.y > ch) {
        d.y -= ch + d.l;
        d.x = (d.x * 7.31) % cw;
      }
      if (d.x > cw) d.x -= cw;
      g.moveTo(d.x, d.y);
      g.lineTo(d.x + d.l * 0.12, d.y + d.l);
    }
    g.stroke();
    if (this.glass) g.restore();
  }
}

// ======================= Sound =======================

/** A sound bed per kind of place, cross-faded. Starts only after the player turns sound on. */
export class Soundscape {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private layers: { stop: () => void; gain: GainNode }[] = [];
  private timers: number[] = [];
  private kind: Kind | null = null;
  on = false;

  enable(on: boolean): void {
    this.on = on;
    if (on && !this.ctx) {
      const Ctx = window.AudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
    }
    if (!this.ctx) return;
    if (on) {
      void this.ctx.resume();
      const k = this.kind;
      this.kind = null;
      if (k) this.set(k);
    } else {
      this.clear();
    }
  }

  private noise(seconds: number, brown: boolean): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 1234567;
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const white = (s / 0x7fffffff) * 2 - 1;
      last = brown ? (last + 0.02 * white) / 1.02 : white;
      d[i] = brown ? last * 3.5 : white;
    }
    return buf;
  }

  private bed(type: BiquadFilterType, freq: number, vol: number, brown = false, q = 0.7): void {
    const ctx = this.ctx as AudioContext;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(4, brown);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 1.5);
    src.connect(f).connect(g).connect(this.master as GainNode);
    src.start();
    this.layers.push({ stop: () => src.stop(), gain: g });
  }

  private tone(freq: number, dur: number, vol: number, type: OscillatorType = "sine"): void {
    const ctx = this.ctx as AudioContext;
    if (!this.on) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master as GainNode);
    o.start(t0);
    o.stop(t0 + dur + 0.1);
  }

  private every(minMs: number, maxMs: number, f: () => void): void {
    const go = () => {
      f();
      this.timers.push(window.setTimeout(go, minMs + Math.random() * (maxMs - minMs)));
    };
    this.timers.push(window.setTimeout(go, minMs + Math.random() * (maxMs - minMs)));
  }

  private clear(): void {
    const ctx = this.ctx;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    for (const l of this.layers) {
      if (ctx) {
        l.gain.gain.cancelScheduledValues(ctx.currentTime);
        l.gain.gain.setValueAtTime(Math.max(0.0001, l.gain.gain.value), ctx.currentTime);
        l.gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
      }
      window.setTimeout(() => l.stop(), 1400);
    }
    this.layers = [];
  }

  set(kind: Kind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    if (!this.on || !this.ctx) return;
    this.clear();
    const indoor = kind === "room" || kind === "office" || kind === "train" || kind === "bath";
    // Rain, everywhere: on the glass indoors, on the street outside.
    this.bed("bandpass", indoor ? 900 : 1600, indoor ? 0.05 : 0.12, false, 0.5);
    switch (kind) {
      case "street":
        this.bed("lowpass", 260, 0.18, true);
        this.every(7000, 16000, () => this.tone(880 + Math.random() * 300, 0.25, 0.02, "triangle"));
        break;
      case "train":
        this.bed("lowpass", 140, 0.35, true);
        this.every(850, 950, () => {
          this.tone(70, 0.12, 0.08, "square");
        });
        break;
      case "room":
        this.bed("lowpass", 120, 0.06, true);
        this.every(1000, 1000, () => this.tone(2400, 0.02, 0.006, "square"));
        break;
      case "port":
        this.bed("lowpass", 180, 0.2, true);
        this.every(12000, 26000, () => this.tone(82, 2.6, 0.06, "sawtooth"));
        break;
      case "river":
        this.bed("lowpass", 420, 0.16, true);
        break;
      case "shrine":
        this.bed("bandpass", 700, 0.05, false, 0.4);
        this.every(2500, 7000, () => this.tone(1900 + Math.random() * 900, 1.8, 0.015));
        break;
      case "high":
        this.bed("lowpass", 200, 0.05, true);
        this.every(5000, 9000, () => [262, 330, 392].forEach((f, i) => window.setTimeout(() => this.tone(f, 1.4, 0.012, "triangle"), i * 180)));
        break;
      case "bath":
        this.bed("highpass", 3000, 0.02);
        this.every(1500, 4000, () => this.tone(1200 + Math.random() * 600, 0.08, 0.02));
        break;
      case "office":
        this.bed("lowpass", 100, 0.05, true);
        this.tone(120, 60, 0.004, "sawtooth");
        break;
    }
  }
}
