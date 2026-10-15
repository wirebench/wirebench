import { openTerminalFor } from './connect.js';

/**
 * A host card's double-click. The first press picks the host (its focus does), the details open, and the
 * right panel narrowing the content can move the card out from under the pointer before the release, let
 * alone the second press: so the first press is what is remembered, and the second press connects that
 * host wherever it lands.
 */
let lastPress: { readonly id: string; readonly x: number; readonly y: number; readonly at: number } | undefined;
/** How far apart, in time and in pixels, the two presses of a double-click may be. */
const DOUBLE_CLICK_MS = 600;
const DOUBLE_CLICK_PX = 6;
/** Until when the click that follows a connecting press is swallowed, so it presses nothing it lands on. */
let swallowClickUntil = 0;

type Press = Pick<MouseEvent, 'button' | 'clientX' | 'clientY' | 'preventDefault' | 'stopPropagation'>;

/** A single press on the host's card. */
export function noteFirstPress(hostId: string, e: Pick<MouseEvent, 'clientX' | 'clientY'>): void {
  lastPress = { id: hostId, x: e.clientX, y: e.clientY, at: performance.now() };
}

/**
 * Connects the host the last press picked when `e` is the second press of a double-click on it, and stops
 * the press there; whether it was. Any second press forgets the first.
 */
export function takeSecondPress(e: Press): boolean {
  const first = lastPress;
  if (e.button !== 0 || first === undefined) return false;
  lastPress = undefined;
  const near = Math.abs(e.clientX - first.x) <= DOUBLE_CLICK_PX && Math.abs(e.clientY - first.y) <= DOUBLE_CLICK_PX;
  if (!near || performance.now() - first.at > DOUBLE_CLICK_MS) return false;
  e.preventDefault();
  e.stopPropagation();
  swallowClickUntil = performance.now() + DOUBLE_CLICK_MS;
  openTerminalFor(first.id);
  return true;
}

/** Swallows the click that follows a connecting press; whether it did. */
export function swallowsClick(e: Pick<MouseEvent, 'detail' | 'preventDefault' | 'stopPropagation'>): boolean {
  if (e.detail < 2 || performance.now() > swallowClickUntil) return false;
  swallowClickUntil = 0;
  e.preventDefault();
  e.stopPropagation();
  return true;
}
