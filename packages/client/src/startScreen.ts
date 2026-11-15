/**
 * The first thing players see: name, then quick race / create a room / join by code /
 * practice offline. Invite links (?room=CODE) pre-fill the code.
 */

export type StartChoice =
  | { mode: 'quick'; name: string }
  | { mode: 'create'; name: string; bots: number }
  | { mode: 'join'; name: string; code: string }
  | { mode: 'offline'; name: string; bots: number };

const NAME_KEY = 'benzina.name';

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Storage unavailable (private mode); fine.
  }
}

export function showStartScreen(opts: { inviteCode?: string | null; error?: string }): Promise<StartChoice> {
  const root = document.createElement('div');
  root.id = 'start';
  const invite = opts.inviteCode?.toUpperCase() ?? '';
  root.innerHTML = `
    <form class="card" autocomplete="off">
      <h1>BENZINA</h1>
      ${invite ? `<p class="invite">You're invited to room <b>${invite}</b></p>` : ''}
      <label class="field">Your name
        <input name="name" maxlength="20" placeholder="Driver" enterkeyhint="go" />
      </label>
      ${
        invite
          ? `<button type="submit" class="primary" data-act="join">Join ${invite}</button>`
          : `<button type="submit" class="primary" data-act="quick">Quick race</button>`
      }
      <div class="row">
        <button type="button" data-act="create">Create private room</button>
        <select name="bots" aria-label="Bots">
          ${[0, 1, 2, 3, 5, 7].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} bots</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <input name="code" maxlength="8" placeholder="Room code" value="${invite}" autocapitalize="characters" />
        <button type="button" data-act="join">Join</button>
      </div>
      <button type="button" class="ghost" data-act="offline">Practice offline</button>
      <p class="error" ${opts.error ? '' : 'hidden'}>${opts.error ?? ''}</p>
    </form>`;
  document.body.appendChild(root);
  document.body.classList.add('menu');

  const form = root.querySelector('form')!;
  const nameInput = form.elements.namedItem('name') as HTMLInputElement;
  const codeInput = form.elements.namedItem('code') as HTMLInputElement;
  const botsSelect = form.elements.namedItem('bots') as HTMLSelectElement;
  const error = root.querySelector<HTMLParagraphElement>('.error')!;
  nameInput.value = savedName();

  return new Promise((resolve) => {
    const choose = (act: string) => {
      const name = nameInput.value.trim().slice(0, 20) || `Driver ${100 + Math.floor(Math.random() * 900)}`;
      saveName(nameInput.value.trim());
      const bots = Number(botsSelect.value);
      let choice: StartChoice;
      if (act === 'join') {
        const code = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!code) {
          error.textContent = 'Enter a room code to join.';
          error.hidden = false;
          codeInput.focus();
          return;
        }
        choice = { mode: 'join', name, code };
      } else if (act === 'create') choice = { mode: 'create', name, bots };
      else if (act === 'offline') choice = { mode: 'offline', name, bots };
      else choice = { mode: 'quick', name };
      root.remove();
      document.body.classList.remove('menu');
      resolve(choice);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const primary = form.querySelector<HTMLButtonElement>('button.primary')!;
      choose(primary.dataset.act!);
    });
    for (const btn of form.querySelectorAll<HTMLButtonElement>('button[type=button]')) {
      btn.addEventListener('click', () => choose(btn.dataset.act!));
    }
  });
}
