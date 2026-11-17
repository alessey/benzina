import { pipeHalfWidth, type TrackDef } from './track';

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

/**
 * Two jumps on two long straights (straights because there's no steering in the air), each
 * with a short, sharp lip and a downhill landing. A banked sweeper links them, an S-section
 * brings you home.
 */
export const IL_SALTO: TrackDef = {
  ...BASE,
  id: 'salto',
  name: 'Il Salto',
  banking: 0.6,
  jumps: true,
  controlPoints: [
    // Main straight north, jump 1: a kicker with a sharp lip, then a long landing slope.
    { x: 0, z: 0, y: 0 },
    { x: 0, z: 60, y: 0 },
    { x: 0, z: 95, y: 0 },
    { x: 0, z: 110, y: 0.8 },
    { x: 0, z: 122, y: 2.6 },
    { x: 0, z: 131, y: 4.6 },
    { x: 0, z: 136, y: 5.9 },
    { x: 0, z: 141, y: 4.4 },
    { x: 0, z: 165, y: 3.8 },
    { x: 0, z: 190, y: 2.6 },
    { x: 0, z: 212, y: 0.9 },
    { x: 0, z: 234, y: 0 },
    { x: 0, z: 262, y: 0 },
    // Banked sweeper east.
    { x: 10, z: 300, y: 0 },
    { x: 60, z: 330, y: 0 },
    { x: 140, z: 335, y: 0 },
    { x: 200, z: 315, y: 0 },
    { x: 235, z: 265, y: 0 },
    // Back straight south, jump 2 (bigger).
    { x: 240, z: 210, y: 0 },
    { x: 240, z: 178, y: 0.8 },
    { x: 240, z: 163, y: 2.8 },
    { x: 240, z: 151, y: 5.2 },
    { x: 240, z: 144, y: 7.0 },
    { x: 240, z: 138, y: 5.4 },
    { x: 240, z: 110, y: 4.8 },
    { x: 240, z: 82, y: 3.2 },
    { x: 240, z: 58, y: 1.2 },
    { x: 240, z: 32, y: 0 },
    { x: 240, z: -40, y: 0 },
    // S-section home.
    { x: 225, z: -100, y: 0 },
    { x: 170, z: -125, y: 0 },
    { x: 110, z: -100, y: 0 },
    { x: 60, z: -120, y: 0 },
    { x: 20, z: -75, y: 0 },
  ],
};

/**
 * A harbour street circuit (inspired by the classic principality street races, not a replica):
 * narrow, walled in, a climb to a hilltop square, a descent to a tight hairpin, a long curving
 * tunnel, a chicane on the exit, the harbour front and a final corner complex.
 */
export const PORTO_AZZURRO: TrackDef = {
  ...BASE,
  id: 'porto',
  name: 'Porto Azzurro',
  width: 11,
  banking: 0.3,
  scenery: 'city',
  controlPoints: [
    // Start/finish line part-way up the main straight (the grid lines up behind it).
    { x: 0, z: 30, y: 0 },
    { x: 0, z: 80, y: 0.3 },
    // Turn 1 (right) and the climb up the hill.
    { x: 20, z: 120, y: 1.2 },
    { x: 80, z: 135, y: 5 },
    { x: 150, z: 150, y: 10 },
    // Hilltop square: left, then right.
    { x: 190, z: 175, y: 13 },
    { x: 205, z: 215, y: 14 },
    { x: 240, z: 232, y: 14 },
    { x: 272, z: 218, y: 13 },
    // The descent.
    { x: 285, z: 180, y: 11 },
    { x: 285, z: 135, y: 8 },
    { x: 278, z: 100, y: 6.5 },
    // The hairpin (left).
    { x: 266, z: 68, y: 5.5 },
    { x: 246, z: 54, y: 5 },
    { x: 228, z: 66, y: 4.6 },
    { x: 226, z: 95, y: 4.2 },
    // Down toward the sea.
    { x: 205, z: 118, y: 3.4 },
    { x: 178, z: 108, y: 2.6 },
    // The tunnel: a long right-hand curve along the harbour.
    { x: 160, z: 82, y: 2 },
    { x: 150, z: 40, y: 1.4 },
    { x: 132, z: 2, y: 1 },
    { x: 104, z: -28, y: 0.6 },
    // Exit chicane.
    { x: 80, z: -44, y: 0.3 },
    { x: 60, z: -38, y: 0.2 },
    { x: 40, z: -54, y: 0 },
    // Harbour front and the swimming-pool wiggle.
    { x: 18, z: -80, y: 0 },
    { x: -12, z: -95, y: 0 },
    // Final corners onto the straight.
    { x: -40, z: -88, y: 0 },
    { x: -42, z: -62, y: 0 },
    { x: -22, z: -46, y: 0 },
    // Onto the main straight, heading north.
    { x: 0, z: -40, y: 0 },
  ],
  tunnel: [18, 21],
  water: [
    { minX: 182, maxX: 520, minZ: -320, maxZ: 28 },
    { minX: -260, maxX: 182, minZ: -320, maxZ: -128 },
  ],
};

/** Bobsled channel: flat floor 7 m wide, walls curving up to 60°, 3 m tall. */
const CANALONE_PIPE = { floor: 3.5, radius: 6, angle: Math.PI / 3 };

/**
 * Canalone: a bobsled-style run down a snowy mountainside in a U-shaped ice channel. Corners
 * swing cars up the outside wall; the faster and tighter, the higher. A climb brings it back
 * to the top.
 */
export const CANALONE: TrackDef = {
  ...BASE,
  id: 'canalone',
  name: 'Canalone',
  width: 2 * pipeHalfWidth(CANALONE_PIPE),
  wallHeight: 0.6,
  pipe: CANALONE_PIPE,
  scenery: 'snow',
  controlPoints: [
    { x: 0, z: 0, y: 34 },
    { x: 0, z: 70, y: 34 },
    { x: 0, z: 130, y: 32 },
    { x: -25, z: 185, y: 30 },
    { x: -80, z: 215, y: 27 },
    { x: -140, z: 200, y: 24 },
    { x: -165, z: 150, y: 21 },
    { x: -140, z: 105, y: 19 },
    { x: -95, z: 80, y: 17 },
    { x: -80, z: 40, y: 15 },
    { x: -110, z: 0, y: 13 },
    { x: -160, z: -20, y: 11 },
    { x: -205, z: -55, y: 9 },
    { x: -210, z: -110, y: 7 },
    { x: -175, z: -150, y: 5 },
    { x: -115, z: -150, y: 4 },
    { x: -70, z: -120, y: 4 },
    { x: -30, z: -140, y: 5 },
    { x: 20, z: -160, y: 8 },
    { x: 80, z: -150, y: 13 },
    { x: 120, z: -110, y: 18 },
    { x: 125, z: -55, y: 23 },
    { x: 95, z: -20, y: 27 },
    { x: 40, z: -60, y: 31 },
    { x: 0, z: -50, y: 34 },
  ],
};

/**
 * Autodromo: a speedway road course. A long front straight past the grandstands, a long
 * banked right-hander at each end and a banked left onto a long, twisty dirt loop out to one
 * side, with two jumps.
 */
export const AUTODROMO: TrackDef = {
  ...BASE,
  id: 'autodromo',
  name: 'Autodromo',
  width: 16,
  scenery: 'speedway',
  jumps: true,
  dirt: [13, 46],
  controlPoints: [
    // Front straight, northward past the grandstands.
    { x: 0, z: -40, bank: 0 },
    { x: 0, z: 30, bank: 0 },
    { x: 0, z: 80, bank: 0 },
    // Turns 1-2: one long banked right-hander, all the way round.
    { x: 0, z: 110, bank: 22 },
    { x: -11.1, z: 136.9, bank: 30 },
    { x: -38, z: 148, bank: 30 },
    { x: -64.9, z: 136.9, bank: 30 },
    { x: -76, z: 110, bank: 22 },
    // Back straight, southward.
    { x: -76, z: 70, bank: 0 },
    { x: -76, z: 40, bank: 0 },
    // Turn 3: banked left, out to the infield loop.
    { x: -76, z: 10, bank: -22 },
    { x: -85.4, z: -12.6, bank: -34 },
    { x: -108, z: -22, bank: -18 },
    // The dirt starts here. Jump 1: a kicker with a sharp lip and a long landing.
    { x: -140, z: -23, y: 0, bank: 0 },
    { x: -151, z: -23, y: 0.6, bank: 0 },
    { x: -160, z: -23, y: 2.0, bank: 0 },
    { x: -166, z: -23, y: 3.4, bank: 0 },
    { x: -170, z: -23, y: 4.0, bank: 0 },
    { x: -175, z: -23, y: 2.8, bank: 0 },
    { x: -190, z: -23, y: 2.3, bank: 0 },
    { x: -205, z: -24, y: 1.2, bank: 0 },
    { x: -222, z: -27, y: 0.2, bank: 0 },
    // The dirt loop: long, twisty and flat.
    { x: -255, z: -46, bank: 0 },
    { x: -285, z: -48, bank: 0 },
    { x: -325, z: -68, bank: 0 },
    { x: -345, z: -105, bank: 0 },
    { x: -330, z: -140, bank: 0 },
    { x: -290, z: -150, bank: 0 },
    { x: -255, z: -128, bank: 0 },
    { x: -220, z: -120, bank: 0 },
    { x: -195, z: -145, bank: 0 },
    { x: -205, z: -180, bank: 0 },
    { x: -245, z: -195, bank: 0 },
    { x: -285, z: -205, bank: 0 },
    { x: -310, z: -235, bank: 0 },
    { x: -290, z: -268, bank: 0 },
    { x: -245, z: -272, bank: 0 },
    // Jump 2 on the way back.
    { x: -205, z: -252, y: 0, bank: 0 },
    { x: -193, z: -250, y: 0.6, bank: 0 },
    { x: -184, z: -249, y: 2.0, bank: 0 },
    { x: -178, z: -248.5, y: 3.4, bank: 0 },
    { x: -174, z: -248, y: 4.0, bank: 0 },
    { x: -169, z: -248, y: 2.8, bank: 0 },
    { x: -154, z: -247, y: 2.3, bank: 0 },
    { x: -139, z: -246, y: 1.2, bank: 0 },
    { x: -122, z: -245.5, y: 0.2, bank: 0 },
    // Back onto tarmac.
    { x: -95, z: -245, y: 0, bank: 0 },
    { x: -65, z: -245, bank: 0 },
    // Turn 4: banked right onto the front straight.
    { x: -32, z: -245, bank: 22 },
    { x: -9.4, z: -235.6, bank: 34 },
    { x: 0, z: -213, bank: 22 },
    { x: 0, z: -170, bank: 0 },
    { x: 0, z: -105, bank: 0 },
  ],
};

export const TRACKS: readonly TrackDef[] = [CIRCUITO_UNO, COLLINE, SERPENTE, IL_SALTO, PORTO_AZZURRO, CANALONE, AUTODROMO];
export const DEFAULT_TRACK = CIRCUITO_UNO;

export function trackById(id: string | undefined): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? DEFAULT_TRACK;
}
