// Procedural sound (Web Audio): gunfire, enemy cannon, hits on the airframe, explosions, turret drive
// motors, jet fly-bys and the piston engine drone. No sample files; everything is synthesized once into
// buffers. Starts on the first key or click (browsers block audio before a user gesture).

type Ctx = AudioContext;

function noiseBuffer(ctx: Ctx, seconds: number, shape: (t: number) => number, color = 0) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = last * color + w * (1 - color); // simple low-pass for darker noise
    d[i] = last * shape(i / ctx.sampleRate);
  }
  return b;
}

export class Sound {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private buf: Record<string, AudioBuffer> = {};
  private motor: { osc: OscillatorNode; gain: GainNode } | null = null;
  private jet: { src: AudioBufferSourceNode; filt: BiquadFilterNode; gain: GainNode } | null = null;
  private drone: { gain: GainNode; osc: OscillatorNode; filt: BiquadFilterNode } | null = null;
  private budget = 0;
  enabled = true;

  constructor() {
    const start = () => this.start();
    window.addEventListener("pointerdown", start);
    window.addEventListener("keydown", start);
  }

  private start() {
    if (this.ctx) { if (this.ctx.state === "suspended") void this.ctx.resume(); return; }
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(comp).connect(ctx.destination);
    // 20 mm shot: sharp crack plus a low thump
    const gun = noiseBuffer(ctx, 0.16, (t) => Math.exp(-t * 38) + 0.25 * Math.exp(-t * 9), 0.35);
    const d = gun.getChannelData(0);
    for (let i = 0; i < d.length; i++) { const t = i / ctx.sampleRate; d[i] += 0.9 * Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t * 22); }
    this.buf.gun = gun;
    this.buf.cannon = noiseBuffer(ctx, 0.25, (t) => Math.exp(-t * 20), 0.6);
    // metallic hit: noise burst through resonances is built at play time
    this.buf.hit = noiseBuffer(ctx, 0.12, (t) => Math.exp(-t * 45), 0.1);
    this.buf.boom = noiseBuffer(ctx, 2.5, (t) => Math.min(1, t * 60) * Math.exp(-t * 1.6), 0.97);
    this.buf.noise = noiseBuffer(ctx, 2.0, () => 1, 0.5);
    // turret drive: amplidyne whine
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 180;
    const mf = ctx.createBiquadFilter();
    mf.type = "lowpass";
    mf.frequency.value = 900;
    const mg = ctx.createGain();
    mg.gain.value = 0;
    osc.connect(mf).connect(mg).connect(this.master);
    osc.start();
    this.motor = { osc, gain: mg };
    // jet fly-by: looping noise, band-passed, gain and pitch from the nearest fighter
    const js = ctx.createBufferSource();
    js.buffer = this.buf.noise;
    js.loop = true;
    const jf = ctx.createBiquadFilter();
    jf.type = "bandpass";
    jf.Q.value = 0.8;
    jf.frequency.value = 900;
    const jg = ctx.createGain();
    jg.gain.value = 0;
    js.connect(jf).connect(jg).connect(this.master);
    js.start();
    this.jet = { src: js, filt: jf, gain: jg };
    // six R-4360s heard through the hull: low rumble with a firing-frequency buzz
    const dn = ctx.createBufferSource();
    dn.buffer = noiseBuffer(ctx, 3.0, () => 1, 0.985);
    dn.loop = true;
    const dosc = ctx.createOscillator();
    dosc.type = "sawtooth";
    dosc.frequency.value = 60;
    const dfilt = ctx.createBiquadFilter();
    dfilt.type = "lowpass";
    dfilt.frequency.value = 220;
    const dg = ctx.createGain();
    dg.gain.value = 0;
    const og = ctx.createGain();
    og.gain.value = 0.12;
    dn.connect(dfilt);
    dosc.connect(og).connect(dfilt);
    dfilt.connect(dg).connect(this.master);
    dn.start();
    dosc.start();
    this.drone = { gain: dg, osc: dosc, filt: dfilt };
  }

  private play(name: string, gain: number, rate = 1, cutoff = 12000) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.enabled || gain < 0.003) return;
    if (this.budget > 60) return; // voices per frame
    this.budget++;
    const s = ctx.createBufferSource();
    s.buffer = this.buf[name];
    s.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = gain;
    s.connect(f).connect(g).connect(this.master);
    s.start();
  }

  /** Distance attenuation and muffling (m). inside: heard through the pressure hull. */
  private att(d: number, inside: boolean) {
    const g = Math.min(1, 6 / (d + 6));
    return { g: inside ? g * 0.55 : g, cut: (inside ? 2500 : 9000) / (1 + d / 60) };
  }

  /** Own 20 mm gun round at distance d (m) from the listener. */
  gun(d: number, inside: boolean) {
    const a = this.att(d, inside);
    this.play("gun", 0.55 * a.g, 0.9 + Math.random() * 0.2, Math.max(400, a.cut));
  }

  enemyGun(d: number, big: boolean) {
    const a = this.att(d, false);
    this.play("cannon", (big ? 0.9 : 0.5) * a.g, big ? 0.7 : 1.1, Math.max(300, a.cut * 0.6));
  }

  /** Shell strikes the airframe at distance d from the listener. */
  hit(d: number, big: boolean) {
    const a = this.att(d, false);
    this.play("hit", (big ? 1.2 : 0.7) * a.g, 0.6 + Math.random() * 0.6, 6000);
    if (big) this.play("boom", 0.5 * a.g, 2.2, 1500);
  }

  explosion(d: number) {
    const a = this.att(d, false);
    this.play("boom", Math.min(1, 40 / (d + 40)) * 1.4, 0.8 + Math.random() * 0.3, Math.max(250, a.cut));
  }

  /** Continuous sounds, once per frame. slew: turret drive load 0..1; jet: nearest fighter (distance, closing m/s). */
  frame(slew: number, jetDist: number, closing: number, power: number) {
    this.budget = 0;
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    if (this.motor) {
      this.motor.gain.gain.setTargetAtTime(0.05 * slew, t, 0.05);
      this.motor.osc.frequency.setTargetAtTime(140 + 260 * slew, t, 0.08);
    }
    if (this.jet) {
      const g = isFinite(jetDist) ? Math.min(0.5, 220 / (jetDist + 50)) : 0;
      this.jet.gain.gain.setTargetAtTime(g, t, 0.1);
      // Doppler: approaching fighters sound higher
      const c = 340;
      this.jet.filt.frequency.setTargetAtTime(700 * Math.max(0.4, Math.min(2.5, c / (c - Math.max(-250, Math.min(250, closing))))), t, 0.1);
    }
    if (this.drone) {
      this.drone.gain.gain.setTargetAtTime(0.18 * power, t, 0.3);
      this.drone.osc.frequency.setTargetAtTime(38 + 28 * power, t, 0.5);
    }
  }
}
