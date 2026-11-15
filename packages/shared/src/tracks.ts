import type { TrackDef } from './track';

const BASE = { width: 14, wallHeight: 1.2, wallThickness: 1, samplesPerSegment: 24 } as const;

/** The original flat circuit. */
export const CIRCUITO_UNO: TrackDef = {
  ...BASE,
  id: 'circuito',
  name: 'Circuito Uno',
  controlPoints: [
    { x: 0, z: 0 },
    { x: 0, z: 120 },
    { x: 30, z: 170 },
    { x: 90, z: 180 },
    { x: 130, z: 140 },
    { x: 120, z: 80 },
    { x: 160, z: 40 },
    { x: 220, z: 50 },
    { x: 250, z: 110 },
    { x: 300, z: 130 },
    { x: 340, z: 80 },
    { x: 320, z: -20 },
    { x: 250, z: -60 },
    { x: 160, z: -50 },
    { x: 80, z: -80 },
    { x: 20, z: -60 },
  ],
};

/** Rolling hills: a climb to a ridge, a fast banked sweeper, and crests that get you light. */
export const COLLINE: TrackDef = {
  ...BASE,
  id: 'colline',
  name: 'Colline',
  banking: 1,
  controlPoints: [
    { x: 0, z: 0, y: 0 },
    { x: 0, z: 100, y: 1 },
    { x: 10, z: 180, y: 4 },
    { x: 60, z: 240, y: 8 },
    { x: 140, z: 260, y: 11 },
    { x: 210, z: 230, y: 12 },
    { x: 240, z: 170, y: 10 },
    { x: 220, z: 110, y: 7 },
    { x: 170, z: 80, y: 6 },
    { x: 150, z: 20, y: 7 },
    { x: 180, z: -40, y: 9 },
    { x: 250, z: -60, y: 8 },
    { x: 310, z: -30, y: 5 },
    { x: 340, z: 40, y: 3 },
    { x: 380, z: 100, y: 2 },
    { x: 420, z: 60, y: 1 },
    { x: 430, z: -40, y: 0 },
    { x: 380, z: -120, y: 0 },
    { x: 290, z: -160, y: 1 },
    { x: 190, z: -160, y: 3 },
    { x: 100, z: -130, y: 2 },
    { x: 40, z: -80, y: 0 },
  ],
};

/** Twisty: a winding climb to a hilltop, then a long snaking descent. */
export const SERPENTE: TrackDef = {
  ...BASE,
  id: 'serpente',
  name: 'Il Serpente',
  banking: 0.7,
  controlPoints: [
    { x: 0, z: 0, y: 0 },
    { x: 0, z: 80, y: 0 },
    { x: -20, z: 150, y: 3 },
    { x: -80, z: 190, y: 7 },
    { x: -150, z: 180, y: 10 },
    { x: -190, z: 130, y: 13 },
    { x: -170, z: 70, y: 15 },
    { x: -110, z: 50, y: 16 },
    { x: -60, z: 10, y: 15 },
    { x: -70, z: -50, y: 13 },
    { x: -130, z: -80, y: 11 },
    { x: -200, z: -70, y: 9 },
    { x: -250, z: -120, y: 7 },
    { x: -230, z: -190, y: 5 },
    { x: -160, z: -220, y: 4 },
    { x: -90, z: -200, y: 3 },
    { x: -40, z: -150, y: 2 },
    { x: 0, z: -90, y: 1 },
  ],
};

export const TRACKS: readonly TrackDef[] = [CIRCUITO_UNO, COLLINE, SERPENTE];
export const DEFAULT_TRACK = CIRCUITO_UNO;

export function trackById(id: string | undefined): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? DEFAULT_TRACK;
}
