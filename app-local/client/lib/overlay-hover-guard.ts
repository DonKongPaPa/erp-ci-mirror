import { useSyncExternalStore } from 'react';

/**
 * A route overlay closed with its X leaves the pointer over whatever sat
 * underneath the button — for a full-height drawer that is the header's account
 * menu, whose trigger opens on hover. Browsers can re-hit-test the page once the
 * panel unmounts and deliver that hover to the trigger, so a menu would open even
 * though the user never aimed at it.
 *
 * While suppressed, the account menu ignores hover. Clicking it still works, and
 * the suppression is released when the pointer leaves the trigger or after a short
 * hold, whichever comes first.
 */
let allowed = true;
let resetTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function suppressHoverAfterOverlayClose(holdMs = 500): void {
  if (resetTimer !== undefined) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => allowHoverAfterOverlayClose(), holdMs);
  if (!allowed) return;
  allowed = false;
  notify();
}

export function allowHoverAfterOverlayClose(): void {
  if (resetTimer !== undefined) {
    clearTimeout(resetTimer);
    resetTimer = undefined;
  }
  if (allowed) return;
  allowed = true;
  notify();
}

/** Whether the account menu may open on hover; the X close button asserts this. */
export function isHoverAllowedAfterOverlayClose(): boolean {
  return allowed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHoverAllowedAfterOverlayClose(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => allowed,
    () => true,
  );
}
