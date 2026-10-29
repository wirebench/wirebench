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
  // Reading `localStorage` itself throws where site data is blocked; the bootstrap guards every use too.
  storage: {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => {
      window.localStorage.setItem(key, value);
    },
  },
});
