/** Bot drivers are named after Formula 1 legends (surnames only, to fit the name tags). */
export const BOT_NAMES = [
  'Fangio',
  'Ascari',
  'Moss',
  'Clark',
  'Stewart',
  'Lauda',
  'Hunt',
  'Senna',
  'Prost',
  'Villeneuve',
  'Brabham',
  'Rindt',
  'Peterson',
  'Mansell',
  'Piquet',
  'Hill',
] as const;

/** A bot name not already in use (falls back to numbered names if all are taken). */
export function pickBotName(taken: Iterable<string>, seed: number): string {
  const used = new Set(taken);
  for (let i = 0; i < BOT_NAMES.length; i++) {
    const name = BOT_NAMES[(seed + i * 7) % BOT_NAMES.length];
    if (!used.has(name)) return name;
  }
  let n = 1;
  while (used.has(`Bot ${n}`)) n++;
  return `Bot ${n}`;
}
