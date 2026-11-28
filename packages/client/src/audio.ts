/**
 * Synthesised sound (Web Audio, no files): engines that follow revs through the gears, tyre
 * screech, wind, crash thumps, countdown beeps and lap chimes.
 *
 * Browsers only allow audio after a user gesture, so the context is created on the first
 * tap/click/keypress (the start screen provides one).
 */

/** Top speed of each gear, m/s; revs climb through each gear's range. */
const GEARS = [11, 19, 27, 35, 46];
const IDLE_RPM = 950;
const REDLINE_RPM = 6800;
const MAX_REMOTE_ENGINES = 3;
const MUTE_KEY = 'benzina.muted';

export interface CarSound {
  id: string;
  local: boolean;
  /** Forward speed, m/s. */
  speed: number;
  /** 0..1 how hard the engine is working. */
  throttle: number;
  /** 0..1 tyre screech amount. */
  slip: number;
  x: number;
  y: number;
  z: number;
}

interface Listener {
  position: { x: number; y: number; z: number };
  /** Unit forward vector of the camera. */
  forward: { x: number; y: number; z: number };
}

function rpmFor(speed: number, throttle: number): number {
  const v = Math.abs(speed);
  if (v < 1) return IDLE_RPM + throttle * 2500; // revving on the spot
  let low = 0;
  for (const top of GEARS) {
    if (v <= top || top === GEARS[GEARS.length - 1]) {
      const t = Math.min(1, (v - low) / (top - low));
      return 2000 + t * (REDLINE_RPM - 2000);
    }
    low = top * 0.82; // next gear starts lower in the rev range
  }
  return REDLINE_RPM;
}

class EngineVoice {
  private readonly oscA: OscillatorNode;
  private readonly oscB: OscillatorNode;
  private readonly oscSub: OscillatorNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private readonly screechGain: GainNode;
  private readonly out: AudioNode;
  readonly panner: PannerNode | null;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    noise: AudioBuffer,
    positional: boolean,
  ) {
    this.panner = positional
      ? new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 8, maxDistance: 300, rolloffFactor: 1.2 })
      : null;
    this.out = this.panner ?? destination;
    if (this.panner) this.panner.connect(destination);

    this.gain = new GainNode(ctx, { gain: 0 });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 900, Q: 4 });
    const shaper = new WaveShaperNode(ctx, { curve: softClip(), oversample: '2x' });
    this.oscA = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 40 });
    this.oscB = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 40, detune: 12 });
    this.oscSub = new OscillatorNode(ctx, { type: 'square', frequency: 20 });
    const mixA = new GainNode(ctx, { gain: 0.35 });
    const mixB = new GainNode(ctx, { gain: 0.25 });
    const mixSub = new GainNode(ctx, { gain: 0.3 });
    this.oscA.connect(mixA).connect(this.filter);
    this.oscB.connect(mixB).connect(this.filter);
    this.oscSub.connect(mixSub).connect(this.filter);
    this.filter.connect(shaper).connect(this.gain).connect(this.out);

    // Tyre screech: band-passed noise.
    const screech = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1900, Q: 3 });
    this.screechGain = new GainNode(ctx, { gain: 0 });
    screech.connect(band).connect(this.screechGain).connect(this.out);

    for (const n of [this.oscA, this.oscB, this.oscSub, screech]) n.start();
  }

  update(car: CarSound, volume: number): void {
    const t = this.ctx.currentTime;
    const rpm = rpmFor(car.speed, car.throttle);
    // Four-cylinder: two firing pulses per revolution.
    const f = (rpm / 60) * 2;
    const smooth = 0.06;
    this.oscA.frequency.setTargetAtTime(f, t, smooth);
    this.oscB.frequency.setTargetAtTime(f * 1.003, t, smooth);
    this.oscSub.frequency.setTargetAtTime(f / 2, t, smooth);
    this.filter.frequency.setTargetAtTime(500 + car.throttle * 1800 + rpm * 0.15, t, 0.08);
    this.gain.gain.setTargetAtTime(volume * (0.16 + car.throttle * 0.12), t, 0.08);
    this.screechGain.gain.setTargetAtTime(volume * car.slip * 0.22, t, 0.05);
    if (this.panner) {
      this.panner.positionX.setTargetAtTime(car.x, t, 0.05);
      this.panner.positionY.setTargetAtTime(car.y, t, 0.05);
      this.panner.positionZ.setTargetAtTime(car.z, t, 0.05);
    }
  }

  stop(): void {
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.screechGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }
}

function softClip(): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2);
  }
  return curve;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private wind: GainNode | null = null;
  private rain: GainNode | null = null;
  private rainLevel = 0;
  private nextThunder = 0;
  private localVoice: EngineVoice | null = null;
  private readonly remoteVoices = new Map<string, EngineVoice>();
  private muted: boolean;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
    const unlock = () => this.unlock();
    for (const type of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(type, unlock, { passive: true });
  }

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): void {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      // Storage unavailable.
    }
    this.master?.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx!.currentTime, 0.05);
  }

  private unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = new GainNode(ctx, { gain: this.muted ? 0 : 0.8 });
    const comp = new DynamicsCompressorNode(ctx, { threshold: -14, ratio: 4 });
    this.master.connect(comp).connect(ctx.destination);
    // One second of white noise, shared by screech, wind and crashes.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const windSrc = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });
    this.wind = new GainNode(ctx, { gain: 0 });
    windSrc.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 420 })).connect(this.wind).connect(this.master);
    windSrc.start();
    // Rain: high band of noise, plus a duller layer for drops on the car.
    const rainSrc = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true, playbackRate: 0.93 });
    this.rain = new GainNode(ctx, { gain: 0 });
    rainSrc
      .connect(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2600, Q: 0.5 }))
      .connect(this.rain)
      .connect(this.master);
    rainSrc.start();
    this.localVoice = new EngineVoice(ctx, this.master, this.noise, false);
  }

  /** Rain ambience, 0..1 (with distant thunder now and then). */
  setRain(level: number): void {
    this.rainLevel = level;
  }

  private thunder(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const src = new AudioBufferSourceNode(ctx, { buffer: this.noise, playbackRate: 0.35 });
    const gain = new GainNode(ctx, { gain: 0 });
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.32, t + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 3.2);
    src.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 140 })).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 3.3);
  }

  /** Call every frame with the cars worth hearing. */
  update(cars: CarSound[], listener: Listener): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.setTargetAtTime(listener.position.x, t, 0.05);
      l.positionY.setTargetAtTime(listener.position.y, t, 0.05);
      l.positionZ.setTargetAtTime(listener.position.z, t, 0.05);
      l.forwardX.setTargetAtTime(listener.forward.x, t, 0.05);
      l.forwardY.setTargetAtTime(listener.forward.y, t, 0.05);
      l.forwardZ.setTargetAtTime(listener.forward.z, t, 0.05);
    }

    const local = cars.find((c) => c.local);
    if (local) this.localVoice!.update(local, 1);
    else this.localVoice!.stop();
    this.wind!.gain.setTargetAtTime(Math.min(0.12, ((local?.speed ?? 0) / 45) ** 2 * 0.12), t, 0.2);
    // Rain louder with speed (tyre hiss on the wet road).
    const rainGain = this.rainLevel * (0.05 + Math.min(0.05, (Math.abs(local?.speed ?? 0) / 45) * 0.05));
    this.rain!.gain.setTargetAtTime(rainGain, t, 0.5);
    if (this.rainLevel > 0) {
      if (this.nextThunder === 0) this.nextThunder = t + 8 + Math.random() * 15;
      if (t > this.nextThunder) {
        this.thunder();
        this.nextThunder = t + 20 + Math.random() * 25;
      }
    } else {
      this.nextThunder = 0;
    }

    // The nearest few other cars get an engine each (CPU on phones).
    const remotes = cars
      .filter((c) => !c.local)
      .map((c) => ({ c, d: Math.hypot(c.x - listener.position.x, c.z - listener.position.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_REMOTE_ENGINES);
    const keep = new Set(remotes.map((r) => r.c.id));
    for (const [id, voice] of this.remoteVoices) {
      if (!keep.has(id)) {
        voice.stop();
        this.remoteVoices.delete(id);
      }
    }
    for (const { c } of remotes) {
      let voice = this.remoteVoices.get(c.id);
      if (!voice) {
        voice = new EngineVoice(ctx, this.master, this.noise, true);
        this.remoteVoices.set(c.id, voice);
      }
      voice.update(c, 0.9);
    }
  }

  /** A short tone (countdown). */
  beep(frequency: number, duration: number, volume = 0.25): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = new OscillatorNode(ctx, { type: 'square', frequency });
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + 0.01);
    g.gain.setValueAtTime(volume, t + duration - 0.03);
    g.gain.linearRampToValueAtTime(0, t + duration);
    osc.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2500 })).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** Rising arpeggio: lap complete (3 notes) or finish (5 notes). */
  chime(notes = 3): void {
    const base = 523.25;
    const steps = [0, 4, 7, 12, 16];
    for (let i = 0; i < notes; i++) {
      setTimeout(() => this.beep(base * 2 ** (steps[i] / 12), 0.16, 0.15), i * 110);
    }
  }

  /**
   * Brassy fanfare for crossing the line: a full "ta-ta-ta-taaa" with a cymbal for a win, a
   * shorter flourish for the podium, the finish chime otherwise.
   */
  fanfare(position: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    if (position > 3) {
      this.chime(5);
      return;
    }
    const n = (semi: number) => 392 * 2 ** (semi / 12); // semitones from G4
    // [start beat, length in beats, semitones of each note in the chord]
    const win: [number, number, number[]][] = [
      [0, 0.5, [0, 4]], [0.5, 0.5, [0, 4]], [1, 0.5, [0, 4]], [1.5, 2.5, [5, 9, 12]],
      [4, 0.5, [2, 7]], [4.5, 0.5, [4, 9]], [5, 4, [5, 9, 12, 17]],
    ];
    const podium: [number, number, number[]][] = [
      [0, 0.5, [0, 4]], [0.5, 0.5, [2, 7]], [1, 3, position === 2 ? [5, 9, 12] : [4, 7, 12]],
    ];
    const beat = 0.15;
    const t0 = ctx.currentTime + 0.05;
    const out = new GainNode(ctx, { gain: position === 1 ? 0.12 : 0.09 });
    out.connect(this.master);
    for (const [start, len, chord] of position === 1 ? win : podium) {
      const t = t0 + start * beat;
      const dur = len * beat;
      for (const semi of chord) {
        // Two detuned saws through a filter that opens on the attack: a cheap brass section.
        const filter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 2, frequency: 600 });
        filter.frequency.setValueAtTime(600, t);
        filter.frequency.linearRampToValueAtTime(3200, t + 0.04);
        filter.frequency.exponentialRampToValueAtTime(1400, t + Math.max(0.08, dur));
        const g = new GainNode(ctx, { gain: 0 });
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1 / chord.length + 0.2, t + 0.02);
        g.gain.setValueAtTime(1 / chord.length + 0.2, t + dur * 0.8);
        g.gain.linearRampToValueAtTime(0, t + dur + 0.12);
        filter.connect(g).connect(out);
        for (const detune of [-7, 7]) {
          const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: n(semi), detune });
          osc.connect(filter);
          osc.start(t);
          osc.stop(t + dur + 0.2);
        }
      }
    }
    // Cymbal crash on the big notes.
    const crashes = position === 1 ? [1.5, 5] : [1];
    for (const beatAt of crashes) {
      const t = t0 + beatAt * beat;
      const src = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });
      const g = new GainNode(ctx, { gain: 0.18 });
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
      src.connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 5000 })).connect(g).connect(this.master);
      src.start(t, Math.random() * 0.3);
      src.stop(t + 1.5);
    }
  }

  /** Impact thump, louder for harder hits. */
  crash(intensity: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const v = Math.min(1, intensity) * 0.7;
    const src = new AudioBufferSourceNode(ctx, { buffer: this.noise });
    const g = new GainNode(ctx, { gain: v });
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 350 + intensity * 700 })).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.4);
    // A knock on top of the rumble.
    const osc = new OscillatorNode(ctx, { type: 'sine', frequency: 95 });
    const og = new GainNode(ctx, { gain: v * 0.8 });
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}
