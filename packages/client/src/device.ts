/**
 * Phone/tablet niceties: fullscreen + landscape lock (where the browser allows it),
 * keeping the screen awake, and blocking browser gestures that fight the game.
 */

export function preventBrowserGestures(): void {
  // iOS Safari pinch-zoom and long-press menus.
  for (const type of ['gesturestart', 'gesturechange', 'contextmenu']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  // Double-tap zoom / scroll bounce on anything that isn't a control.
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
}

/** Fullscreen and landscape lock. Android Chrome supports both; iPhone Safari supports neither. */
export function fullscreenSupported(): boolean {
  return document.fullscreenEnabled === true;
}

export async function enterFullscreenLandscape(): Promise<void> {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    // Not in all TS DOM typings yet; only works while fullscreen.
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await orientation.lock?.('landscape');
  } catch {
    // User agent refused; the game still works.
  }
}

/** Keep the screen from dimming mid-race. Needs a user gesture first on some browsers. */
export function keepScreenAwake(): void {
  type WakeLockNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } };
  const nav = navigator as WakeLockNav;
  if (!nav.wakeLock) return;
  let held = false;
  const request = async () => {
    if (held || document.visibilityState !== 'visible') return;
    try {
      const lock = (await nav.wakeLock!.request('screen')) as EventTarget;
      held = true;
      lock.addEventListener('release', () => (held = false));
    } catch {
      // Denied (battery saver, no gesture yet); try again on the next interaction.
    }
  };
  document.addEventListener('pointerdown', request);
  document.addEventListener('visibilitychange', request);
  void request();
}
