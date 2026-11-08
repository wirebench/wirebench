/**
 * User profile Task 4 (spec §6.2, §9): `PATCH /me` for the username and about text, the image routes, and the profile
 * card. Each refusal has its positive control.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { cleanAbout } from '../../../src/identity/routes/me.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';
import { chunk, riff, vp8, vp8x, webpFor } from '../../helpers/webp.js';

type Signed = Awaited<ReturnType<typeof signedInUser>>;

const versionOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

describe('cleanAbout (ruling 13)', () => {
  it('trims, keeps line breaks, folds CRLF and drops other control characters', () => {
    expect(cleanAbout('  Hello\r\nworld\t!\u0000\u0007 \n')).toBe('Hello\nworld!');
    expect(cleanAbout('a\u001b[31mred')).toBe('a[31mred');
    expect(cleanAbout('<b>bold</b>')).toBe('<b>bold</b>');
  });
});

describeDb('the user profile routes (user profile spec §6.2)', () => {
  let h: IdentityHarness;
  let ada: Signed;
  let bob: Signed;
  beforeEach(async () => {
    h = await identityHarness();
    ada = await signedInUser(h, { email: 'ada@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
  });
  afterEach(() => h.close());

  const patchMe = (who: Signed, payload: object) =>
    h.app.inject({ method: 'PATCH', url: '/api/v1/me', headers: who.headers, payload });
  const putImage = (who: Signed, kind: string, data: Buffer | string) =>
    h.app.inject({
      method: 'PUT',
      url: `/api/v1/me/images/${kind}`,
      headers: who.headers,
      payload: { contentType: 'image/webp', data: typeof data === 'string' ? data : data.toString('base64') },
    });
  const getImage = (who: Signed, id: string, kind: string, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'GET', url: `/api/v1/users/${id}/images/${kind}`, headers: { ...who.headers, ...headers } });
  const profileOf = (who: Signed, id: string) =>
    h.app.inject({ method: 'GET', url: `/api/v1/users/${id}/profile`, headers: who.headers });
  const code = (res: { json: <T>() => T }) => res.json<{ code: string }>().code;
  const joinTeam = async (team: string, ...people: Signed[]) => {
    await h.tdb.query('insert into teams (id, name) values ($1, $1) on conflict do nothing', [team]);
    for (const person of people) {
      await h.tdb.query("insert into team_members (team_id, user_id, role) values ($1, $2, 'member')", [
        team,
        person.user.id,
      ]);
    }
  };

  describe('PATCH /me', () => {
    it('sets a username (stored lower-case) and about text, and GET /me shows them', async () => {
      const res = await patchMe(ada, { username: ' Ada.L ', about: '  Hi\r\nthere  ' });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ user: object }>().user).toMatchObject({ username: 'ada.l', about: 'Hi\nthere', photo: null });
      const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: ada.headers });
      expect(me.json()).toEqual(res.json());
    });

    it('refuses an empty body, and answers each field’s own problem', async () => {
      const empty = await patchMe(ada, {});
      expect([empty.statusCode, code(empty)]).toEqual([400, 'identity-update-empty']);
      for (const username of ['ab', 'a'.repeat(31), '-ada', 'ada@example', 'Ádá', 'ада', 'Admin', 'me']) {
        const res = await patchMe(ada, { username });
        expect([res.statusCode, code(res)], username).toEqual([400, 'identity-username-invalid']);
      }
      const about = await patchMe(ada, { about: 'x'.repeat(501) });
      expect([about.statusCode, code(about)]).toEqual([400, 'identity-about-invalid']);
      // Control characters do not count towards the limit: they are gone before it is checked.
      expect((await patchMe(ada, { about: `${'x'.repeat(500)}\u0000\u0000` })).statusCode).toBe(200);
      expect((await patchMe(ada, { name: '  ' })).statusCode).toBe(400);
    });

    it('answers 409 for a username someone else holds in any case, and frees a cleared one at once', async () => {
      expect((await patchMe(ada, { username: 'ada' })).statusCode).toBe(200);
      const taken = await patchMe(bob, { username: 'ADA' });
      expect([taken.statusCode, code(taken)]).toEqual([409, 'identity-username-taken']);
      const cleared = await patchMe(ada, { username: null });
      expect(cleared.json<{ user: object }>().user, cleared.body).toMatchObject({ username: null });
      expect((await patchMe(bob, { username: 'ADA' })).statusCode).toBe(200);
    });

    it('records one user.updated naming what changed, never the values, and nothing for no change', async () => {
      const events = recordingAudit(h.hooks);
      await patchMe(ada, { name: 'Ada Lovelace', username: 'ada', about: 'Engines' });
      expect(events.map((e) => [e.action, e.target, e.details])).toEqual([
        [
          'user.updated',
          { kind: 'user', id: ada.user.id },
          { fields: ['displayName', 'username', 'about'], via: 'self' },
        ],
      ]);
      expect(JSON.stringify(events)).not.toMatch(/Lovelace|Engines|"ada"/);
      // The same values again, the username in another case (ruling 5): nothing is written.
      expect((await patchMe(ada, { name: ' Ada Lovelace ', username: 'ADA', about: 'Engines ' })).statusCode).toBe(200);
      expect(events).toHaveLength(1);
      expect((await repo.findUserById(h.tdb, ada.user.id))?.username).toBe('ada');
    });

    it('limits a person to 30 changes a minute, with Retry-After', async () => {
      for (let i = 0; i < 30; i++) expect((await patchMe(ada, { about: `n${String(i)}` })).statusCode).toBe(200);
      const limited = await patchMe(ada, { about: 'one more' });
      expect([limited.statusCode, code(limited)]).toEqual([429, 'identity-profile-rate-limited']);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Per person: another is not held by Ada's bucket.
      expect((await patchMe(bob, { about: 'fine' })).statusCode).toBe(200);
      h.clock.advance(60_000);
      expect((await patchMe(ada, { about: 'later' })).statusCode).toBe(200);
    });
  });

  describe('PUT and DELETE /me/images/:kind', () => {
    it('stores a photo and a cover, answers their versions, and shows them on GET /me', async () => {
      const photo = webpFor('photo');
      const cover = webpFor('cover');
      const put = await putImage(ada, 'photo', photo);
      expect([put.statusCode, put.json()]).toEqual([200, { version: versionOf(photo) }]);
      expect((await putImage(ada, 'cover', cover)).json()).toEqual({ version: versionOf(cover) });
      const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: ada.headers });
      expect(me.json<{ user: object }>().user).toMatchObject({
        photo: { version: versionOf(photo) },
        cover: { version: versionOf(cover) },
      });
      expect(
        (await h.app.inject({ method: 'DELETE', url: '/api/v1/me/images/photo', headers: ada.headers })).statusCode,
      ).toBe(204);
      expect(
        (await h.app.inject({ method: 'DELETE', url: '/api/v1/me/images/photo', headers: ada.headers })).statusCode,
      ).toBe(204);
      expect((await repo.findUserById(h.tdb, ada.user.id))?.photo).toBeNull();
    });

    it('refuses what the server cannot vouch for, each with its problem', async () => {
      const invalid = async (data: Buffer | string, kind = 'photo') => {
        const res = await putImage(ada, kind, data);
        return [res.statusCode, code(res)];
      };
      expect(await invalid(webpFor('cover'))).toEqual([400, 'identity-image-invalid']);
      expect(await invalid(webpFor('photo'), 'cover')).toEqual([400, 'identity-image-invalid']);
      expect(await invalid(riff(vp8x(256, 256, 0x08), vp8(256, 256)))).toEqual([400, 'identity-image-invalid']);
      expect(await invalid(riff(vp8x(256, 256), vp8(256, 256), chunk('EXIF', Buffer.alloc(8))))).toEqual([
        400,
        'identity-image-invalid',
      ]);
      expect(await invalid(riff(vp8x(256, 256, 0x02), vp8(256, 256)))).toEqual([400, 'identity-image-invalid']);
      expect(await invalid(Buffer.from('GIF89a-not-a-webp'))).toEqual([400, 'identity-image-invalid']);
      expect(await invalid('not base64!')).toEqual([400, 'identity-image-invalid']);
      expect(await invalid(`${webpFor('photo').toString('base64')}\n`)).toEqual([400, 'identity-image-invalid']);
      expect(await invalid(webpFor('photo', 512 * 1024))).toEqual([413, 'identity-image-too-large']);
      expect(await invalid(webpFor('cover', 2 * 1024 * 1024), 'cover')).toEqual([413, 'identity-image-too-large']);
      expect((await putImage(ada, 'banner', webpFor('photo'))).statusCode).toBe(400);
      expect(await repo.getImage(h.tdb, ada.user.id, 'photo')).toBeUndefined();
    });

    it('records user.updated with the kind, for an upload and a removal, and nothing for removing nothing', async () => {
      const events = recordingAudit(h.hooks);
      await putImage(ada, 'photo', webpFor('photo'));
      await h.app.inject({ method: 'DELETE', url: '/api/v1/me/images/photo', headers: ada.headers });
      await h.app.inject({ method: 'DELETE', url: '/api/v1/me/images/cover', headers: ada.headers });
      expect(events.map((e) => e.details)).toEqual([
        { fields: ['photo'], via: 'self' },
        { fields: ['photo'], via: 'self' },
      ]);
    });

    it('limits a person to 20 uploads an hour', async () => {
      for (let i = 0; i < 20; i++) expect((await putImage(ada, 'photo', webpFor('photo', i + 1))).statusCode).toBe(200);
      const limited = await putImage(ada, 'photo', webpFor('photo'));
      expect([limited.statusCode, code(limited)]).toEqual([429, 'identity-profile-rate-limited']);
      expect((await putImage(bob, 'photo', webpFor('photo'))).statusCode).toBe(200);
    });
  });

  describe('GET /users/:id/images/:kind', () => {
    it('serves the bytes with the headers of spec §9, and 304 for the version the caller has', async () => {
      const photo = webpFor('photo');
      await putImage(ada, 'photo', photo);
      // Anyone signed in on the same server, team mate or not.
      const res = await getImage(bob, ada.user.id, 'photo');
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(photo)).toBe(true);
      const sha = createHash('sha256').update(photo).digest('hex');
      expect(res.headers).toMatchObject({
        'content-type': 'image/webp',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline; filename="photo.webp"',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=86400',
        etag: `"${sha}"`,
      });
      const again = await getImage(bob, ada.user.id, 'photo', { 'if-none-match': `"${sha}"` });
      expect([again.statusCode, again.rawPayload.length]).toEqual([304, 0]);
      expect((await getImage(bob, ada.user.id, 'photo', { 'if-none-match': '"other"' })).statusCode).toBe(200);
    });

    it('answers 404 for an unset image or an unknown person, and 401 when signed out', async () => {
      expect((await getImage(bob, ada.user.id, 'cover')).statusCode).toBe(404);
      expect((await getImage(bob, 'nobody', 'photo')).statusCode).toBe(404);
      await putImage(ada, 'photo', webpFor('photo'));
      const signedOut = await h.app.inject({ method: 'GET', url: `/api/v1/users/${ada.user.id}/images/photo` });
      expect(signedOut.statusCode).toBe(401);
    });
  });

  describe('GET /users/:id/profile (ruling 3)', () => {
    it('shows a team mate the profile card', async () => {
      await patchMe(ada, { username: 'ada', about: 'Engines\n<b>and</b> notes' });
      const photo = webpFor('photo');
      await putImage(ada, 'photo', photo);
      await joinTeam('t-one', ada, bob);
      const res = await profileOf(bob, ada.user.id);
      expect([res.statusCode, res.json()]).toEqual([
        200,
        {
          id: ada.user.id,
          displayName: 'ada',
          email: 'ada@example.com',
          username: 'ada',
          about: 'Engines\n<b>and</b> notes',
          photo: { version: versionOf(photo) },
          cover: null,
        },
      ]);
    });

    it('answers 404 to a stranger, as for nobody at all, and shows the person and a server admin', async () => {
      const eve = await signedInUser(h, { email: 'eve@example.com' });
      const admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
      await joinTeam('t-one', ada, bob);
      await joinTeam('t-two', eve);
      const stranger = await profileOf(eve, ada.user.id);
      const nobody = await profileOf(eve, 'nobody');
      expect([stranger.statusCode, stranger.body]).toEqual([nobody.statusCode, nobody.body]);
      expect(stranger.statusCode).toBe(404);
      expect((await profileOf(ada, ada.user.id)).statusCode).toBe(200);
      expect((await profileOf(admin, ada.user.id)).statusCode).toBe(200);
    });
  });
});
