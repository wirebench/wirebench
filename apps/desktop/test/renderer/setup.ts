/**
 * jsdom lacks the browser APIs the layout and palette primitives reach for. Stubbing them
 * keeps the shell render tests honest about markup and behaviour without pretending jsdom
 * does layout.
 */
// Main-process test files opt into the `node` environment, where none of this exists (and
// none of it is needed); the guard keeps this one shared setup file usable by both.
const isBrowserLike = typeof globalThis.document !== 'undefined';

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (isBrowserLike) {
  globalThis.ResizeObserver ??= NoopResizeObserver;
}

// cmdk scrolls the highlighted item into view; jsdom has no scrolling.
if (isBrowserLike && !('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
}

// `@tanstack/react-virtual` measures its scroll container's `offsetHeight` synchronously on
// mount (before any `ResizeObserver` callback runs), and jsdom always reports 0 for both —
// which would mount only a single virtualized row in every test. A fixed stand-in keeps
// virtualized views (the outline, history) rendering a realistic row count under test.
if (isBrowserLike && Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.configurable !== false) {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
}
