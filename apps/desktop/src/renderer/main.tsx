import './styles/tailwind.css';
import { z } from 'zod';

// The renderer runs under `default-src 'self'` with no `'unsafe-eval'`. zod 4 otherwise probes
// `new Function('')` once, lazily, to decide whether it may JIT object parsers; under this CSP
// the probe is refused and Chromium logs a console error (which the e2e console gate treats
// as a failure). Jitless mode skips the probe — object parsing stays interpreted, which is
// more than fast enough for IPC payloads.
z.config({ jitless: true });
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { applyInitialTheme } from './lib/theme.js';

// Before the first paint, not in an effect: `system` on a light OS would otherwise render one
// dark frame while `theme.get` is in flight. The preload bakes the OS scheme in at load time.
applyInitialTheme();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
