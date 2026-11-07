/**
 * User profile Task 3: the repository's profile reads and writes (spec §6.1). The username is unique per tenant and
 * free again once cleared; images carry their version on the user row; a team mate is someone on one shared team.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USERNAME_KEY, isUsernameTaken } from '../../../src/db/errors.js';
import * as repo from '../../../src/identity/repo.js';
import { newId } from '../../../src/identity/tokens.js';
import { listMembers } from '../../../src/teams/repo.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { createTenancy, directoryOf } from '../../../src/tenancy/tenancy.js';
import { tenantDbFactory } from '../../../src/tenancy/tenant-db.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const SHA = 'ab'.repeat(32);

describeDb('identity repo: the profile (user profile spec §6.1)', () => {
  let h: IdentityHarness;
  const user = (email: string) =>
    repo.insertUser(h.tdb, {
      id: newId(),
      email,
      displayName: email.split('@')[0]!,
      serverAdmin: false,
      at: h.clock.now,
    });
  const photo = (userId: string, sha256 = SHA) =>
    repo.putImage(h.tdb, {
      userId,
      kind: 'photo',
      contentType: 'image/webp',
      data: Buffer.from('webp bytes'),
      sha256,
      at: h.clock.now,
    });

  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  it('starts with no username, an empty about text and no images', async () => {
    const ada = await user('ada@example.com');
    expect(ada).toMatchObject({ username: null, about: '', photo: null, cover: null });
  });

  describe('setProfile', () => {
    it('writes only the fields given, keeps the typed case, and finds the user by the lower-cased name', async () => {
      const ada = await user('ada@example.com');
      await repo.setProfile(h.tdb, ada.id, { username: 'Ada.L' });
      await repo.setProfile(h.tdb, ada.id, { about: 'Line one\nLine two' });
      await repo.setProfile(h.tdb, ada.id, {});
      expect(await repo.findUserById(h.tdb, ada.id)).toMatchObject({
        displayName: 'ada',
        username: 'Ada.L',
        about: 'Line one\nLine two',
      });
      expect((await repo.findUserByUsername(h.tdb, 'ada.l'))?.id).toBe(ada.id);
      expect(await repo.findUserByUsername(h.tdb, 'Ada.L')).toBeUndefined();
      await repo.setProfile(h.tdb, ada.id, { displayName: 'Ada Lovelace', username: null });
      expect(await repo.findUserById(h.tdb, ada.id)).toMatchObject({ displayName: 'Ada Lovelace', username: null });
      expect(await repo.findUserByUsername(h.tdb, 'ada.l')).toBeUndefined();
    });

    it('refuses a username another person holds, in any case, under the key the route maps', async () => {
      const ada = await user('ada@example.com');
      const bob = await user('bob@example.com');
      await repo.setProfile(h.tdb, ada.id, { username: 'ada' });
      const error = await repo.setProfile(h.tdb, bob.id, { username: 'ADA' }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ constraint: USERNAME_KEY });
      expect(isUsernameTaken(error)).toBe(true);
      // Freed, it is anyone's at once.
      await repo.setProfile(h.tdb, ada.id, { username: null });
      await repo.setProfile(h.tdb, bob.id, { username: 'ADA' });
      expect((await repo.findUserByUsername(h.tdb, 'ada'))?.id).toBe(bob.id);
    });

    it("lets two tenants' people hold the same username", async () => {
      const ada = await user('ada@example.com');
      await repo.setProfile(h.tdb, ada.id, { username: 'ada' });
      const created = await new TenantAdmin(h.db, directoryOf(createTenancy(h.db))).create({
        slug: 'profile-repo',
        name: 'profile-repo',
      });
      const other = tenantDbFactory(h.db)(created.scope);
      try {
        const twin = await repo.insertUser(other, {
          id: newId(),
          email: 'ada@other.example',
          displayName: 'Ada',
          serverAdmin: false,
          at: h.clock.now,
        });
        await repo.setProfile(other, twin.id, { username: 'ada' });
        expect((await repo.findUserByUsername(other, 'ada'))?.id).toBe(twin.id);
        expect((await repo.findUserByUsername(h.tdb, 'ada'))?.id).toBe(ada.id);
        // Each tenant's unit sees only its own person's images.
        await photo(ada.id);
        expect(await repo.getImage(other, ada.id, 'photo')).toBeUndefined();
      } finally {
        await other.query('delete from users');
        await h.db.owner.query('delete from tenants where id = $1', [created.scope.tenantId]);
      }
    });
  });

  describe('images', () => {
    it('stores, replaces, reads and deletes an image, with its version on the user row', async () => {
      const ada = await user('ada@example.com');
      await photo(ada.id);
      expect(await repo.getImage(h.tdb, ada.id, 'photo')).toMatchObject({
        contentType: 'image/webp',
        data: Buffer.from('webp bytes'),
        sha256: SHA,
      });
      expect(await repo.findUserById(h.tdb, ada.id)).toMatchObject({ photo: SHA.slice(0, 16), cover: null });
      await photo(ada.id, 'cd'.repeat(32));
      expect((await repo.findUserByEmail(h.tdb, 'ada@example.com'))?.photo).toBe('cd'.repeat(8));
      expect(await repo.deleteImage(h.tdb, ada.id, 'photo')).toBe(true);
      expect(await repo.deleteImage(h.tdb, ada.id, 'photo')).toBe(false);
      expect(await repo.getImage(h.tdb, ada.id, 'photo')).toBeUndefined();
      expect((await repo.findUserById(h.tdb, ada.id))?.photo).toBeNull();
    });

    it('goes with its user', async () => {
      const ada = await user('ada@example.com');
      await photo(ada.id);
      await h.tdb.query('delete from users where id = $1', [ada.id]);
      expect(await repo.getImage(h.tdb, ada.id, 'photo')).toBeUndefined();
    });
  });

  it('sharesTeam is true for members of one team only, in either order', async () => {
    const [ada, bob, eve] = [
      await user('ada@example.com'),
      await user('bob@example.com'),
      await user('eve@example.com'),
    ];
    await h.tdb.query("insert into teams (id, name) values ('t-one', 'One'), ('t-two', 'Two')");
    await h.tdb.query(
      "insert into team_members (team_id, user_id, role) values ('t-one', $1, 'admin'), ('t-one', $2, 'member'), ('t-two', $3, 'admin')",
      [ada.id, bob.id, eve.id],
    );
    expect(await repo.sharesTeam(h.tdb, ada.id, bob.id)).toBe(true);
    expect(await repo.sharesTeam(h.tdb, bob.id, ada.id)).toBe(true);
    expect(await repo.sharesTeam(h.tdb, ada.id, eve.id)).toBe(false);
    expect(await repo.sharesTeam(h.tdb, ada.id, 'nobody')).toBe(false);
  });

  it('lists team members with their username and photo version', async () => {
    const ada = await user('ada@example.com');
    const bob = await user('bob@example.com');
    await repo.setProfile(h.tdb, ada.id, { username: 'Ada' });
    await photo(ada.id);
    await h.tdb.query("insert into teams (id, name) values ('t-one', 'One')");
    await h.tdb.query(
      "insert into team_members (team_id, user_id, role) values ('t-one', $1, 'admin'), ('t-one', $2, 'member')",
      [ada.id, bob.id],
    );
    expect((await listMembers(h.tdb, 't-one')).map(({ email, username, photo: p }) => [email, username, p])).toEqual([
      ['ada@example.com', 'Ada', { version: SHA.slice(0, 16) }],
      ['bob@example.com', null, null],
    ]);
  });
});
