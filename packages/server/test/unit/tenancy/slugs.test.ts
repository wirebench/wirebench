/** Reserved slugs (hosted edition spec §21.2). */
import { AREAS } from '@wirebench/wire/area-module';
import { KINDS } from '@wirebench/wire/kinds/kind-module';
import { describe, expect, it } from 'vitest';
import type { Querier } from '../../../src/db/querier.js';
import { TenantAdmin, type TenantDirectory } from '../../../src/tenancy/directory.js';
import { checkSlug, RESERVED_SLUGS } from '../../../src/tenancy/slugs.js';

describe('checkSlug', () => {
  it('accepts an ordinary slug', () => {
    expect(checkSlug('acme')).toBe('ok');
    expect(checkSlug('acme-2')).toBe('ok');
  });

  it.each(['', '-acme', 'acme-', 'Acme', 'ac_me', 'a'.repeat(41), 'acme.co'])('refuses %j as invalid', (slug) => {
    expect(checkSlug(slug)).toBe('slug-invalid');
  });

  it('refuses every reserved slug that the syntax allows', () => {
    for (const slug of RESERVED_SLUGS) {
      expect(checkSlug(slug), slug).toBe(slug.length < 3 ? 'slug-invalid' : 'slug-reserved');
    }
  });

  it('holds the spec §3.6 names, the brand names and the entry', () => {
    for (const slug of ['app', 'api', 'www', 'docs', 'status', 'admin', 'agent', 'mail', 'help', 'support']) {
      expect(RESERVED_SLUGS.has(slug), slug).toBe(true);
    }
    for (const slug of ['billing', 'login', 'signup', 'wirebench', 'verathic', 'default']) {
      expect(RESERVED_SLUGS.has(slug), slug).toBe(true);
    }
  });

  it('reserves every area id and every protocol kind id the app has', () => {
    const ids = [
      ...AREAS.flatMap((area) => [area.id, area.feature.id]),
      ...KINDS.flatMap((kind) => [kind.kind, kind.feature.id]),
    ];
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.filter((id) => !RESERVED_SLUGS.has(id))).toEqual([]);
  });
});

describe('TenantAdmin.create', () => {
  /** A database that fails the test if anything reaches it: a refused slug writes nothing. */
  const db = {
    query: () => Promise.reject(new Error('a refused slug reached the database')),
  } as unknown as Querier;
  const admin = new TenantAdmin(db, {} as TenantDirectory);

  it.each(['app', 'api', 'wirebench', 'soap', 'default'])(
    'refuses the reserved slug %s before any write',
    async (slug) => {
      await expect(admin.create({ slug, name: 'X' })).rejects.toMatchObject({ code: 'tenancy-slug-reserved' });
    },
  );

  it('refuses an invalid slug before any write', async () => {
    await expect(admin.create({ slug: 'Not A Slug', name: 'X' })).rejects.toMatchObject({
      code: 'tenancy-slug-invalid',
    });
  });
});
