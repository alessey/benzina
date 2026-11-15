import { buildTrack, DEFAULT_TRACK, DT, type Track } from '@benzina/shared';
import { Room, type RoomOptions } from './room';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

/** Owns all rooms and drives them from a single fixed-rate loop. */
export class Lobby {
  private readonly rooms = new Map<string, Room>();
  private readonly track: Track = buildTrack(DEFAULT_TRACK);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly defaults: RoomOptions = {}) {}

  /** Join a room by code. Unknown codes create a private room, so invite links never dead-end. */
  joinByCode(code: string, options: RoomOptions = {}): Room {
    const key = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || randomCode();
    return this.rooms.get(key) ?? this.create(key, { ...options, isPublic: false });
  }

  /** A new private room with a fresh code. */
  createPrivate(options: RoomOptions = {}): Room {
    return this.create(this.freshCode(), { ...options, isPublic: false });
  }

  /**
   * Quick play: a public room waiting in its lobby, else any public room with space
   * (you'll spectate until the race ends), else a new public room.
   */
  quickPlay(options: RoomOptions = {}): Room {
    const open = [...this.rooms.values()].filter((r) => r.isPublic && r.hasRoomForHuman);
    return (
      open.find((r) => r.race.phase === 'lobby') ??
      open[0] ??
      this.create(this.freshCode(), { ...options, isPublic: true })
    );
  }

  private create(code: string, options: RoomOptions): Room {
    const room = new Room(code, this.track, { ...this.defaults, ...options });
    this.rooms.set(code, room);
    return room;
  }

  private freshCode(): string {
    let key = randomCode();
    while (this.rooms.has(key)) key = randomCode();
    return key;
  }

  /** Call after a player leaves; empty rooms are discarded. */
  cleanup(room: Room): void {
    if (room.humanCount === 0 && this.rooms.get(room.code) === room) {
      room.dispose();
      this.rooms.delete(room.code);
    }
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  start(): void {
    const stepMs = DT * 1000;
    let next = performance.now();
    const loop = () => {
      const now = performance.now();
      // Catch up if we fell behind, but never spiral: after 250 ms behind, resync.
      if (now - next > 250) next = now;
      while (now >= next) {
        for (const room of this.rooms.values()) room.tick();
        next += stepMs;
      }
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }
}
