import { TRACKS, type PlayerInfo, type RaceState } from '@benzina/shared';
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
}

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

  constructor(
    private readonly actions: { start(laps: number): void; invite(): void; selectTrack(id: string): void },
  ) {
    this.panel.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'start') this.actions.start(this.laps);
      if (act === 'invite') this.actions.invite();
      if (act === 'laps-') this.laps = Math.max(1, this.laps - 1);
      if (act === 'laps+') this.laps = Math.min(20, this.laps + 1);
      if (act === 'track-' || act === 'track+') {
        const i = TRACKS.findIndex((t) => t.id === this.trackId);
        const next = TRACKS[(i + (act === 'track+' ? 1 : -1) + TRACKS.length) % TRACKS.length];
        this.actions.selectTrack(next.id);
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
    else if (me?.finishTime != null && race.phase === 'racing') banner = `Finished P${me.position}!`;
    else if (v.wrongWay && race.phase === 'racing') banner = '<span class="warn">WRONG WAY</span>';
    this.set(this.banner, banner);

    // Lobby and results card.
    const panelKey = JSON.stringify([
      race.phase,
      v.trackId,
      v.isHost,
      this.laps,
      [...v.players.values()].map((p) => p.name),
      race.phase === 'results' ? race.standings : null,
      race.phase === 'results' ? Math.ceil((race.phaseEndsTick - v.now) / 60) : 0,
    ]);
    if (panelKey !== this.lastPanelKey) {
      this.lastPanelKey = panelKey;
      this.set(this.panel, this.renderPanel(v));
    }
  }

  private renderPanel(v: RaceView): string {
    const { race } = v;
    const startControls = v.isHost
      ? `<div class="laps"><button data-act="laps-" aria-label="Fewer laps">−</button><span>${this.laps} lap${this.laps === 1 ? '' : 's'}</span><button data-act="laps+" aria-label="More laps">+</button></div>
         <button class="primary" data-act="start">${race.phase === 'results' ? 'Race again' : 'Start race'}</button>`
      : `<p class="muted">Waiting for the host to start…</p>`;
    const invite = v.online ? `<button data-act="invite">Invite friends</button>` : '';
    const trackName = escapeHtml(TRACKS.find((t) => t.id === v.trackId)?.name ?? v.trackId);
    const trackRow = v.isHost
      ? `<div class="laps track"><button data-act="track-" aria-label="Previous track">◀</button><span>${trackName}</span><button data-act="track+" aria-label="Next track">▶</button></div>`
      : `<p class="muted">Track: ${trackName}</p>`;

    if (race.phase === 'lobby') {
      const names = [...v.players.values()]
        .map((p) => `<li>${escapeHtml(p.name)}${p.bot ? ' <em>bot</em>' : ''}</li>`)
        .join('');
      return `<div class="card">
        <div class="title">${v.online ? `Room ${v.room}` : 'Practice'} <span class="muted">· warm up, then start</span></div>
        <ul class="players">${names}</ul>
        ${trackRow}
        <div class="actions">${startControls}${invite}</div>
      </div>`;
    }

    if (race.phase === 'results') {
      const rows = race.standings
        .map(
          (s) =>
            `<tr class="${s.id === v.localId ? 'me' : ''}"><td>${s.dnf ? '–' : s.position}</td><td>${this.name(s.id, v.players)}</td><td>${s.dnf ? 'DNF' : formatTime(s.finishTime)}</td><td class="muted">${formatTime(s.bestLap)}</td></tr>`,
        )
        .join('');
      const secs = Math.max(0, Math.ceil((race.phaseEndsTick - v.now) / 60));
      return `<div class="card results">
        <div class="title">Results</div>
        <table><thead><tr><th></th><th>Driver</th><th>Time</th><th>Best lap</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">Back to the lobby in ${secs}s</p>
        ${trackRow}
        <div class="actions">${startControls}</div>
      </div>`;
    }
    return '';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
