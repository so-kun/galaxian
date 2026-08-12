/**
 * Sample-based sound.
 *
 * These recordings come from JOTD's galaxian500 project and capture the real
 * board's discrete sound section (via emulation) -- the swooping shot, the
 * dive scream, the swarm loop. Playing them back beats any synthesis we could
 * do here: exact Galaxian audio is unsolved even in MAME, whose driver still
 * carries a TODO saying the background hum runs slow and the explosion is too
 * hard, and whose audio device notes that the CD4066 mixing cannot be
 * reproduced by a discrete netlist at all.
 *
 * The swarm loop's playback rate rises the longer a stage runs, standing in
 * for the original's tempo escalation ("the longer the level takes to
 * complete, the faster and angrier the swarm is").
 */

const SOUND_FILES = {
  shoot: 'shoot.wav',
  alienShot: 'alien_shot.wav',
  flagshipShot: 'flagship_shot.wav',
  playerShot: 'player_shot.wav',
  intro: 'intro.wav',
  credit: 'credit.wav',
  extraLife: 'extra_life.wav',
  attackStart: 'attack_start.wav',
  attackEnd: 'attack_end.wav',
  swarmLoop: 'swarm_1.wav',
} as const;

type SoundName = keyof typeof SOUND_FILES;

interface PlayOptions {
  gain?: number;
  rate?: number;
}

/**
 * How long a sound asked for during start-up may wait for the buffers.
 *
 * The gesture that unlocks audio is usually the coin going in, so that first
 * effect arrives before anything can be decoded. Holding it briefly is the
 * difference between a silent first coin and a heard one; holding it for
 * longer than this would just play a sound the player has stopped expecting.
 */
const PENDING_MAX_AGE_MS = 1000;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private ready = false;

  /** Set while start() is in flight, which is when one-shots are held. */
  private starting = false;
  private resuming = false;
  private pending: { name: SoundName; options: PlayOptions; at: number }[] = [];

  private swarmSource: AudioBufferSourceNode | null = null;
  private diveSource: AudioBufferSourceNode | null = null;
  private keepAlive: AudioBufferSourceNode | null = null;

  /** Must be called from a user gesture. */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.starting = true;
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;

      const entries = Object.entries(SOUND_FILES) as [SoundName, string][];
      await Promise.all(
        entries.map(async ([name, file]) => {
          try {
            const res = await fetch(`sounds/${file}`);
            const data = await res.arrayBuffer();
            this.buffers.set(name, await ctx.decodeAudioData(data));
          } catch {
            // A missing file just means that effect stays silent.
          }
        }),
      );
      this.ready = true;
      this.startKeepAlive(ctx);
    } finally {
      this.starting = false;
      this.flushPending();
    }
  }

  /**
   * Bring back a context the browser has parked. Safe to call at any time,
   * and cheap when nothing is wrong.
   *
   * Leaving the game sitting in attract means minutes without a single
   * effect, and a context that produces nothing for that long can end up
   * suspended -- after which every sound is silently dropped until
   * something, switching tabs being the usual one, wakes it again.
   */
  resumeIfNeeded(): void {
    const ctx = this.ctx;
    if (!ctx || this.resuming || ctx.state === 'running') return;
    this.resuming = true;
    void ctx.resume().then(
      () => {
        this.resuming = false;
        this.flushPending();
      },
      () => {
        this.resuming = false;
        this.pending = [];
      },
    );
  }

  /**
   * A silent looping source, connected for as long as the page lives.
   *
   * It keeps the graph producing samples through the quiet stretches, so the
   * output stream stays open instead of being parked and having to be
   * reacquired when the next coin goes in.
   */
  private startKeepAlive(ctx: AudioContext): void {
    if (this.keepAlive) return;
    // One second of zeroes, looped: nothing to hear, everything to keep open.
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate), ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(ctx.destination);
    source.start();
    this.keepAlive = source;
  }

  /** Play whatever was asked for while the buffers were still decoding. */
  private flushPending(): void {
    const held = this.pending;
    this.pending = [];
    if (!this.ready) return;
    const now = performance.now();
    for (const p of held) {
      if (now - p.at <= PENDING_MAX_AGE_MS) this.play(p.name, p.options);
    }
  }

  get isRunning(): boolean {
    return this.ready;
  }

  private play(name: SoundName, options: PlayOptions = {}): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    if (!this.ready || !ctx || ctx.state !== 'running') {
      // Hold a one-shot that arrived with the unlocking gesture itself, or
      // while a parked context is waking up. The cap keeps a slow decode
      // from queueing up a burst of stale effects.
      if ((this.starting || this.ready) && this.pending.length < 4) {
        this.pending.push({ name, options, at: performance.now() });
      }
      this.resumeIfNeeded();
      return null;
    }
    const buffer = this.buffers.get(name);
    if (!buffer) return null;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (options.rate) source.playbackRate.value = options.rate;
    const gain = ctx.createGain();
    gain.gain.value = options.gain ?? 1;
    source.connect(gain).connect(ctx.destination);
    source.start();
    return source;
  }

  playerShoot(): void {
    this.play('shoot', { gain: 0.8 });
  }

  alienDeath(): void {
    this.play('alienShot');
  }

  flagshipDeath(): void {
    this.play('flagshipShot');
  }

  playerDeath(): void {
    this.stopDive();
    this.play('playerShot');
  }

  gameStart(): void {
    this.play('intro', { gain: 0.9 });
  }

  extraLife(): void {
    this.play('extraLife');
  }

  coin(): void {
    this.play('credit');
  }

  /** The dive scream. One at a time is plenty, as on the board. */
  diveStart(): void {
    if (!this.ready || !this.ctx) return;
    if (this.diveSource) return;
    const source = this.play('attackStart', { gain: 0.7 });
    if (!source) return;
    this.diveSource = source;
    source.onended = () => {
      this.diveSource = null;
    };
  }

  private stopDive(): void {
    try {
      this.diveSource?.stop();
    } catch {
      // already stopped
    }
    this.diveSource = null;
  }

  /** The background swarm loop, with a tempo that climbs during the stage. */
  setSwarmLoop(playing: boolean, rate: number): void {
    if (!this.ready || !this.ctx) return;

    if (!playing) {
      if (this.swarmSource) {
        try {
          this.swarmSource.stop();
        } catch {
          // already stopped
        }
        this.swarmSource = null;
      }
      return;
    }

    if (!this.swarmSource) {
      const buffer = this.buffers.get('swarmLoop');
      if (!buffer) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.55;
      source.connect(gain).connect(this.ctx.destination);
      source.start();
      this.swarmSource = source;
    }
    this.swarmSource.playbackRate.value = rate;
  }
}
