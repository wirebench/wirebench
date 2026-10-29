import { z } from 'zod';

// Imported first by `entry.ts`, before anything that builds a zod schema: the page runs under
// `default-src 'self'` with no `'unsafe-eval'`, and zod would otherwise probe `new Function('')`. The
// renderer's `main.tsx` sets the same, but it loads only after the bootstrap's own imports.
z.config({ jitless: true });
