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

  /**
   * Join a specific room by code (created on demand), or quick-play into the first room
   * with space.
   */
  findRoom(code: string | null, options: RoomOptions = {}): Room {
    const opts = { ...this.defaults, ...options };
    if (code) {
      const key = code.toUpperCase().slice(0, 8);
      let room = this.rooms.get(key);
      if (!room) {
        room = new Room(key, this.track, opts);
        this.rooms.set(key, room);
      }
      return room;
    }
    for (const room of this.rooms.values()) if (room.hasRoomForHuman) return room;
    let key = randomCode();
    while (this.rooms.has(key)) key = randomCode();
    const room = new Room(key, this.track, opts);
    this.rooms.set(key, room);
    return room;
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
