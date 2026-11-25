/**
 * Every sound is synthesised with the Web Audio API: no file is loaded, nothing is fetched.
 * Sound starts only after the player turns it on (browsers require a gesture anyway).
 */
export type Sfx = "step" | "run" | "door" | "pick" | "unlock" | "copy" | "badge" | "notice" | "alert" | "lure" | "relay" | "fail" | "win";

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private rain: AudioBufferSourceNode | null = null;
  enabled = false;

  enable(on: boolean): void {
    this.enabled = on;
    if (on && !this.ctx) {
      const Ctx = window.AudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (!this.ctx || !this.master) return;
    if (on) {
      void this.ctx.resume();
      this.startRain();
    } else {
      this.rain?.stop();
      this.rain = null;
    }
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    // A fixed pseudo-random sequence: the same rain every time.
    let s = 12345;
    for (let i = 0; i < d.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (s / 0x7fffffff) * 2 - 1;
    }
    return buf;
  }

  /** Soft rain on the windows: filtered noise, very low. */
  private startRain(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.rain) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(3);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 200;
    const g = ctx.createGain();
    g.gain.value = 0.06;
    src.connect(lp).connect(hp).connect(g).connect(this.master);
    src.start();
    this.rain = src;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, when = 0, slide?: number): void {
    const ctx = this.ctx as AudioContext;
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master as GainNode);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private burst(dur: number, freq: number, vol: number, when = 0): void {
    const ctx = this.ctx as AudioContext;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(dur + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(this.master as GainNode);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  play(s: Sfx): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    switch (s) {
      case "step":
        this.burst(0.05, 1800, 0.05);
        break;
      case "run":
        this.burst(0.06, 900, 0.18);
        this.burst(0.06, 900, 0.15, 0.12);
        break;
      case "door":
        this.tone(90, 0.18, "sine", 0.25, 0, 60);
        break;
      case "pick":
        for (let i = 0; i < 3; i++) this.burst(0.02, 4200, 0.12, i * 0.09);
        break;
      case "unlock":
        this.tone(660, 0.08, "square", 0.08);
        this.tone(990, 0.12, "square", 0.08, 0.08);
        break;
      case "copy":
        for (let i = 0; i < 6; i++) this.tone(1200 + i * 180, 0.05, "square", 0.05, i * 0.06);
        break;
      case "badge":
        this.tone(880, 0.1, "triangle", 0.12);
        break;
      case "notice":
        this.tone(520, 0.25, "sine", 0.12, 0, 780);
        break;
      case "alert":
        this.tone(440, 0.5, "sawtooth", 0.12);
        this.tone(466, 0.5, "sawtooth", 0.12);
        this.tone(220, 0.7, "square", 0.08, 0.1);
        break;
      case "lure":
        for (let i = 0; i < 4; i++) this.tone(150, 0.07, "square", 0.08, i * 0.1);
        break;
      case "relay":
        this.tone(120, 0.4, "sawtooth", 0.1, 0, 40);
        break;
      case "fail":
        this.tone(330, 0.3, "triangle", 0.15, 0, 160);
        break;
      case "win":
        [523, 659, 784].forEach((f, i) => this.tone(f, 0.35, "triangle", 0.12, i * 0.12));
        break;
    }
  }
}
