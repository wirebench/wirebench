/**
 * Puts the docs site under the landing site, so GitHub Pages can serve both from one artifact: the
 * landing site at `/wirebench/` and the user guide at `/wirebench/docs/`. Astro's `dist/` is not
 * prefixed by `base`, so the docs build lands at `docs-site/dist/index.html` and is copied whole
 * under `site/dist/docs/`.
 *
 * `node scripts/site-assemble.ts` runs after both builds; `pnpm site:assemble` runs the whole chain
 * (site build, docs build, this copy).
 */
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const docsDist = fileURLToPath(new URL('../docs-site/dist/', import.meta.url));
const target = fileURLToPath(new URL('../site/dist/docs/', import.meta.url));
await rm(target, { recursive: true, force: true });
await cp(docsDist, target, { recursive: true });
process.stdout.write('site: docs copied into site/dist/docs\n');
