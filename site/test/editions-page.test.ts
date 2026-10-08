import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the editions page in step with the licensing terms the server enforces. The terms are read
 * from the engine's source as text, so the site does not depend on the engine package.
 */
const page = readFileSync(new URL('../src/pages/editions.astro', import.meta.url), 'utf-8');
const licensing = readFileSync(new URL('../../packages/engine/src/server-api/licensing.ts', import.meta.url), 'utf-8');

function constant(name: string): number {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(licensing);
  if (!match) throw new Error(`${name} not found in licensing.ts`);
  return Number(match[1]);
}

describe('editions page', () => {
  it('states the Community seats the server allows', () => {
    expect(page).toContain(`${constant('COMMUNITY_SEATS')} seats, no license needed`);
  });

  it('states the grace period the server allows', () => {
    expect(page).toContain(`${constant('GRACE_DAYS')} days of grace`);
  });

  it('names the three editions', () => {
    for (const edition of ['Community', 'Team', 'Enterprise']) {
      expect(page).toContain(`<th scope="row">${edition}</th>`);
    }
  });
});
