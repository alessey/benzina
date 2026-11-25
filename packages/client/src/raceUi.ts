import { CLASS_SPECS, TRACKS, WEATHER_NAMES, WEATHERS, type BotSettings, type CarChoice, type PlayerInfo, type RaceState, type Track, type Weather } from '@benzina/shared';
import { carPickerHtml, handlePickerClick, hex } from './carPicker';
import { formatTime } from './lapTimer';

export interface RaceView {
  race: RaceState;
  players: ReadonlyMap<string, PlayerInfo>;
  localId: string | null;
  isHost: boolean;
  /** Current authoritative tick, aligned with our car. */
  now: number;
  online: boolean;
  room?: string;
  spectating: boolean;
  wrongWay: boolean;
  /** Free-practice lap timer, shown in the lobby. */
  practice: { current: number | null; last: number | null; best: number | null };
  trackId: string;
  track: Track;
  /** Our car choice (null when spectating). */
  myCar: CarChoice | null;
  botSettings: BotSettings;
  weather: Weather;
}

/** What each weather means for the race, under its name in the lobby. */
const WEATHER_NOTES: Record<Weather, string> = {
  clear: 'Dry, full grip',
  overcast: 'Dry, flat light',
  rain: 'Wet: less grip, longer braking, puddles',
  fog: 'Dry, but corners appear late',
  dusk: 'Dry, low sun and long shadows',
};

const TICK_SECONDS = 1 / 60;

/**
 * Race overlay: lobby card (players, laps, start, invite), countdown, live standings,
 * results, spectating banner and wrong-way warning. Only touches the DOM when text changes.
 */
export class RaceUi {
  private readonly panel = document.getElementById('race-panel')!;
  private readonly countdown = document.getElementById('countdown')!;
  private readonly standings = document.getElementById('standings')!;
  private readonly banner = document.getElementById('banner')!;
  private readonly lapBox = document.getElementById('lap')!;
  private laps = 3;
  private cache = new Map<HTMLElement, string>();
  private lastPanelKey = '';

  private trackId = '';
  private weather: Weather = 'clear';
  private weatherAskedAt = 0;
  private myCar: CarChoice | null = null;
  private bots: BotSettings = { difficulty: 'normal', catchUp: false };
  /** Is the "change car" picker open on the results card? */
  private picking = false;
  /** Lobby card minimised to a bar (to warm up unobstructed). */
  private collapsed = false;
  /** The lobby/results card is showing (not hidden to the bar). */
  cardOpen = false;

  constructor(
    private readonly actions: {
      start(laps: number): void;
      invite(): void;
      selectTrack(id: string): void;
      setCar(car: CarChoice): void;
      setBots(settings: BotSettings): void;
      setWeather(weather: Weather): void;
    },
  ) {
    this.panel.addEventListener('click', (e) => {
      if (this.myCar) {
        const picked = handlePickerClick(e.target, this.myCar);
        if (picked) {
          this.actions.setCar(picked);
          return;
        }
      }
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'pick') {
        this.picking = !this.picking;
        this.lastPanelKey = '';
      }
      if (act === 'collapse' || act === 'expand') {
        this.collapsed = act === 'collapse';
        this.lastPanelKey = '';
      }
      if (act?.startsWith('bots-')) this.actions.setBots({ ...this.bots, difficulty: act.slice(5) as BotSettings['difficulty'] });
      if (act === 'catchup') this.actions.setBots({ ...this.bots, catchUp: !this.bots.catchUp });
      if (act === 'start') this.actions.start(this.laps);
      if (act === 'invite') this.actions.invite();
      if (act === 'laps-') this.laps = Math.max(1, this.laps - 1);
      if (act === 'laps+') this.laps = Math.min(20, this.laps + 1);
      if (act === 'track-' || act === 'track+') {
        const i = TRACKS.findIndex((t) => t.id === this.trackId);
        const next = TRACKS[(i + (act === 'track+' ? 1 : -1) + TRACKS.length) % TRACKS.length];
        this.actions.selectTrack(next.id);
      }
      if (act === 'weather-' || act === 'weather+') {
        const i = WEATHERS.indexOf(this.weather);
        // Step from what we last asked for, so quick clicks online don't repeat a step.
        this.weather = WEATHERS[(i + (act === 'weather+' ? 1 : -1) + WEATHERS.length) % WEATHERS.length];
        this.weatherAskedAt = performance.now();
        this.actions.setWeather(this.weather);
      }
      if (act?.startsWith('laps')) this.lastPanelKey = '';
    });
  }

  private set(el: HTMLElement, html: string): void {
    if (this.cache.get(el) === html) return;
    this.cache.set(el, html);
    el.innerHTML = html;
    el.hidden = html === '';
  }

  private name(id: string, players: ReadonlyMap<string, PlayerInfo>): string {
    return escapeHtml(players.get(id)?.name ?? `Car ${id}`);
  }

  update(v: RaceView): void {
    const { race } = v;
    this.trackId = v.trackId;
    // Our own pick wins for a moment while the server confirms it.
    if (performance.now() - this.weatherAskedAt > 1500) this.weather = v.weather;
    this.myCar = v.myCar;
    this.bots = v.botSettings;
    const me = race.standings.find((s) => s.id === v.localId);

    // Lap box: race info while racing, practice timer otherwise.
    if (me && (race.phase === 'countdown' || race.phase === 'racing')) {
      const current = race.phase === 'racing' ? (v.now - (me.started ? me.lapStartTick : race.startTick)) * TICK_SECONDS : null;
      const lap = Math.min(race.laps, me.lapsDone + 1);
      this.set(
        this.lapBox,
        `<div class="big">P${me.position}<small>/${race.standings.length}</small> <span class="lapcount">LAP ${lap}/${race.laps}</span></div>
         <div><span class="label">TIME</span> ${formatTime(me.finishTime ?? current)}</div>
         <div><span class="label">BEST</span> ${formatTime(me.bestLap)}</div>`,
      );
    } else {
      this.set(
        this.lapBox,
        `<div><span class="label">LAP</span> ${formatTime(v.practice.current)}</div>
         <div><span class="label">LAST</span> ${formatTime(v.practice.last)}</div>
         <div><span class="label">BEST</span> ${formatTime(v.practice.best)}</div>`,
      );
    }

    // Countdown: 3, 2, 1, GO!
    let count = '';
    if (race.phase === 'countdown') count = String(Math.max(1, Math.ceil((race.startTick - v.now) / 60)));
    else if (race.phase === 'racing' && v.now - race.startTick < 50) count = 'GO!';
    this.set(this.countdown, count ? `<span class="${count === 'GO!' ? 'go' : ''}">${count}</span>` : '');

    // Live standings while racing.
    if (race.phase === 'countdown' || race.phase === 'racing') {
      const rows = race.standings
        .map((s) => {
          const status = s.dnf ? 'DNF' : s.finishTime !== null ? formatTime(s.finishTime) : `L${Math.min(race.laps, s.lapsDone + 1)}`;
          return `<li class="${s.id === v.localId ? 'me' : ''}"><span>${s.position}</span>${this.name(s.id, v.players)}<em>${status}</em></li>`;
        })
        .join('');
      this.set(this.standings, `<ol>${rows}</ol>`);
    } else {
      this.set(this.standings, '');
    }

    // Banner: spectating / wrong way / finish.
    let banner = '';
    if (v.spectating && race.phase !== 'lobby') banner = "Spectating: you'll join the next race";
    else if (me?.finishTime != null && race.phase === 'racing') banner = finishMessage(me.position);
    else if (v.wrongWay && race.phase === 'racing') banner = '<span class="warn">WRONG WAY</span>';
    this.set(this.banner, banner);

    // Lobby and results card. While it's open, the arrow keys orbit the camera.
    this.cardOpen = (race.phase === 'lobby' && !this.collapsed) || race.phase === 'results';
    const panelKey = JSON.stringify([
      race.phase,
      v.trackId,
      v.weather,
      v.myCar,
      v.botSettings,
      this.picking,
      this.collapsed,
      [...v.players.values()].map((p) => p.car),
      v.isHost,
      this.laps,
      [...v.players.values()].map((p) => p.name),
      race.phase === 'results' ? race.standings : null,
      race.phase === 'results' ? Math.ceil((race.phaseEndsTick - v.now) / 60) : 0,
    ]);
    if (panelKey !== this.lastPanelKey) {
      this.lastPanelKey = panelKey;
      this.set(this.panel, this.renderPanel(v));
      const preview = this.panel.querySelector<HTMLCanvasElement>('canvas.track-preview');
      if (preview) drawTrackPreview(preview, v.track);
    }
  }

  private renderPanel(v: RaceView): string {
    const { race } = v;
    const isResults = race.phase === 'results';
    if (race.phase !== 'lobby' && !isResults) return '';

    const trackName = escapeHtml(TRACKS.find((t) => t.id === v.trackId)?.name ?? v.trackId);
    const hasBots = [...v.players.values()].some((p) => p.bot);
    const roomTitle = v.online ? `Room <b>${v.room}</b>` : '<b>Practice</b>';

    // Collapsed: a slim bar so you can warm up without the card in the way.
    if (this.collapsed && !isResults) {
      return `<div class="card lobby-bar">
        <span>${roomTitle} · ${v.players.size} driver${v.players.size === 1 ? '' : 's'} · ${trackName} · ${weatherName(v.weather, v.track)}</span>
        ${v.isHost ? `<button class="primary" data-act="start">Start race</button>` : ''}
        <button data-act="expand">Show</button>
      </div>`;
    }

    // --- Your car
    const carSection = v.myCar
      ? isResults
        ? `<section><h3>Your car</h3>
             <div class="my-car"><span class="dot" style="background:${hex(v.myCar.color)}"></span>
             <b>${CLASS_SPECS[v.myCar.cls].name}</b>
             <button data-act="pick">${this.picking ? 'Done' : 'Change'}</button></div>
             ${this.picking ? carPickerHtml(v.myCar) : ''}</section>`
        : `<section><h3>Your car</h3>${carPickerHtml(v.myCar)}</section>`
      : '';

    // --- Drivers
    const drivers = [...v.players.values()]
      .map(
        (p) =>
          `<li><span class="dot" style="background:${hex(p.car.color)}"></span><span class="who">${escapeHtml(p.name)}</span><em>${CLASS_SPECS[p.car.cls].name}${p.bot ? ' · bot' : ''}</em></li>`,
      )
      .join('');
    const driversSection = `<section><h3>Drivers <span class="muted">${v.players.size}/8</span></h3><ul class="drivers">${drivers}</ul></section>`;

    // --- Race settings
    const trackControl = v.isHost
      ? `<div class="stepper track"><button data-act="track-" aria-label="Previous track">◀</button><span>${trackName}</span><button data-act="track+" aria-label="Next track">▶</button></div>`
      : `<div class="track-name">${trackName}</div>`;
    const levels = (['easy', 'normal', 'hard'] as const)
      .map((d) => `<button data-act="bots-${d}" class="${v.botSettings.difficulty === d ? 'on' : ''}">${d[0].toUpperCase() + d.slice(1)}</button>`)
      .join('');
    const settings = v.isHost
      ? `<div class="setting"><span class="label-sm">Laps</span>
           <div class="stepper"><button data-act="laps-" aria-label="Fewer laps">−</button><span>${this.laps}</span><button data-act="laps+" aria-label="More laps">+</button></div></div>
         ${
           hasBots
             ? `<div class="setting"><span class="label-sm">Bots</span><div class="seg">${levels}</div></div>
                <div class="setting"><span class="label-sm">Catch-up</span>
                  <button data-act="catchup" class="toggle ${v.botSettings.catchUp ? 'on' : ''}" title="Bots ahead ease off, bots behind push harder">${v.botSettings.catchUp ? 'On' : 'Off'}</button></div>`
             : ''
         }
         <button class="primary start" data-act="start">${isResults ? 'Race again' : 'Start race'}</button>`
      : `${hasBots ? `<p class="muted">Bots: ${v.botSettings.difficulty}${v.botSettings.catchUp ? ', catch-up on' : ''}</p>` : ''}
         <p class="waiting">Waiting for the host to start…</p>`;
    const raceSection = `<section><h3>Race</h3>
        <div class="track-row"><canvas class="track-preview" width="150" height="104"></canvas>
          <div class="track-side">${trackControl}<div class="muted track-facts">${trackFacts(v.track)}</div></div></div>
        <div class="setting weather"><span class="label-sm">Weather</span>
          ${
            v.isHost
              ? `<div class="stepper track"><button data-act="weather-" aria-label="Previous weather">◀</button><span>${weatherName(v.weather, v.track)}</span><button data-act="weather+" aria-label="Next weather">▶</button></div>`
              : `<b>${weatherName(v.weather, v.track)}</b>`
          }</div>
        <div class="muted weather-note">${weatherNote(v.weather, v.track)}</div>
        ${settings}
      </section>`;

    const header = `<header>
        <div>${roomTitle}${v.online ? '' : ''} <span class="muted">${isResults ? '· results' : '· warm up, then start'}</span></div>
        <div class="header-actions">
          ${v.online ? `<button data-act="invite">Invite</button>` : ''}
          ${isResults ? '' : `<button data-act="collapse" aria-label="Hide">Hide</button>`}
        </div>
      </header>`;

    if (isResults) {
      const rows = race.standings
        .map(
          (s) =>
            `<tr class="${s.id === v.localId ? 'me' : ''}"><td>${s.dnf ? '–' : s.position}</td><td>${this.name(s.id, v.players)}</td><td>${s.dnf ? 'DNF' : formatTime(s.finishTime)}</td><td class="muted">${formatTime(s.bestLap)}</td></tr>`,
        )
        .join('');
      const secs = Math.max(0, Math.ceil((race.phaseEndsTick - v.now) / 60));
      return `<div class="card lobby results">
        ${header}
        <section class="wide"><table><thead><tr><th></th><th>Driver</th><th>Time</th><th>Best lap</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">Back to the lobby in ${secs}s</p></section>
        <div class="columns">${carSection ? `<div>${carSection}</div>` : ''}<div>${raceSection}</div></div>
      </div>`;
    }

    return `<div class="card lobby">
      ${header}
      <div class="columns">
        <div>${carSection}${driversSection}</div>
        <div>${raceSection}</div>
      </div>
    </div>`;
  }
}

/** "You won!", "You came in 2nd", ... */
function finishMessage(position: number): string {
  if (position === 1) return 'You won!';
  const rem100 = position % 100;
  const rem10 = position % 10;
  const suffix = rem100 >= 11 && rem100 <= 13 ? 'th' : rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th';
  return `You came in ${position}${suffix}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A line of facts about a track: length, climb, features. */
/** Weather as it applies to this track: on a snow road, rain falls as snow. */
function weatherName(weather: Weather, track: Track): string {
  return weather === 'rain' && track.def.snow ? 'Snowfall' : WEATHER_NAMES[weather];
}

function weatherNote(weather: Weather, track: Track): string {
  if (weather === 'rain' && track.def.snow) return 'Fresh snow: even less grip';
  if (weather === 'rain' && track.dirt) return 'Wet: less grip, puddles, mud on the dirt';
  return WEATHER_NOTES[weather];
}

function trackFacts(track: Track): string {
  const facts = [`${(track.length / 1000).toFixed(2)} km`];
  if (track.bounds.maxY > 2) facts.push(`${Math.round(track.bounds.maxY)} m climb`);
  if (track.def.jumps) facts.push('jumps');
  if (track.def.tunnel) facts.push('tunnel');
  if (track.def.scenery === 'city') facts.push('street circuit');
  if (track.def.pipe) facts.push('bobsled channel');
  if (track.steepBanks) facts.push('banked turns');
  if (track.dirt) facts.push('dirt');
  if (track.def.snow) facts.push('snow road');
  if (track.gap) facts.push('chasm');
  return facts.join(' · ');
}

/** Overhead outline of a track, with the start marked. */
function drawTrackPreview(canvas: HTMLCanvasElement, track: Track): void {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = canvas.width;
  const h = canvas.height;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const b = track.bounds;
  const pad = 10;
  const scale = Math.min((w - pad * 2) / (b.maxX - b.minX), (h - pad * 2) / (b.maxZ - b.minZ));
  const ox = w / 2 - ((b.minX + b.maxX) / 2) * scale;
  const oz = h / 2 + ((b.minZ + b.maxZ) / 2) * scale;
  const at = (x: number, z: number): [number, number] => [ox + x * scale, oz - z * scale];
  const path = new Path2D();
  track.samples.forEach((s, i) => (i === 0 ? path.moveTo(...at(s.x, s.z)) : path.lineTo(...at(s.x, s.z))));
  path.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 5;
  ctx.stroke(path);
  ctx.strokeStyle = '#3c4046';
  ctx.lineWidth = 3;
  ctx.stroke(path);
  if (track.tunnel) {
    // Tunnel section drawn darker.
    const [a, c] = track.tunnel;
    const tunnel = new Path2D();
    for (let i = a, k = 0; k < track.samples.length; i = (i + 1) % track.samples.length, k++) {
      const s = track.samples[i];
      if (k === 0) tunnel.moveTo(...at(s.x, s.z));
      else tunnel.lineTo(...at(s.x, s.z));
      if (i === c) break;
    }
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    ctx.setLineDash([3, 2]);
    ctx.stroke(tunnel);
    ctx.setLineDash([]);
  }
  const s0 = track.samples[0];
  const [sx, sy] = at(s0.x, s0.z);
  ctx.fillStyle = '#e23b2e';
  ctx.beginPath();
  ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
  ctx.fill();
}
