/** The page's script (`index.html`): runs the bootstrap against the real page. */
import './zod-jitless.js';
import { startBrowserClient } from './browser-bootstrap.js';

void startBrowserClient({
  location: window.location,
  document,
  fetch: (url, init) => fetch(url, init),
  target: window,
  mountRenderer: () => import('../renderer/main.js'),
  matchMedia: (query) => window.matchMedia(query),
});
