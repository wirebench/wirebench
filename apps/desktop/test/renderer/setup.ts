/**
 * jsdom lacks the browser APIs the layout and palette primitives reach for. Stubbing them
 * keeps the shell render tests honest about markup and behaviour without pretending jsdom
 * does layout.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= NoopResizeObserver;

// cmdk scrolls the highlighted item into view; jsdom has no scrolling.
if (!('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
}
