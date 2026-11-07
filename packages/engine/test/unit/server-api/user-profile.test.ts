import { describe, expect, it } from 'vitest';
import {
  IMAGE_LIMITS,
  imageRefSchema,
  imageUploadRequestSchema,
  isValidUsername,
  localSignInRequestSchema,
  meUpdateRequestSchema,
  serverUserSchema,
  teamMemberSchema,
  usernameSchema,
} from '../../../src/index.js';

describe('user profile schemas (user profile spec §2, §5, §6.2)', () => {
  it.each([
    ['ada', true],
    ['Ada.Lovelace', true],
    ['a_b-c.9', true],
    ['9lives', true],
    ['x'.repeat(30), true],
    ['ab', false],
    ['x'.repeat(31), false],
    ['.ada', false],
    ['-ada', false],
    ['ada@example.com', false],
    ['ada lovelace', false],
    // Cyrillic "а": look-alike letters are refused (§9).
    ['аda', false],
    ['admin', false],
    ['ADMIN', false],
    ['Wirebench', false],
    ['me', false],
  ])('username %j is valid: %s', (value, valid) => {
    expect(isValidUsername(value)).toBe(valid);
  });

  it('usernameSchema checks the pattern but leaves the reserved list to the handler', () => {
    expect(usernameSchema.safeParse('admin').success).toBe(true);
    expect(usernameSchema.safeParse('a@b').success).toBe(false);
  });

  it('PATCH /me takes any of name, username (null clears) and about', () => {
    expect(meUpdateRequestSchema.parse({ username: null })).toEqual({ username: null });
    expect(meUpdateRequestSchema.parse({ about: 'Hi\nthere' }).about).toBe('Hi\nthere');
    expect(meUpdateRequestSchema.parse({ name: 'Ada', username: 'ada' })).toEqual({ name: 'Ada', username: 'ada' });
    expect(meUpdateRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('sign-in takes an identifier, or an email from an older desktop', () => {
    const rest = { password: 'x'.repeat(12), device: { name: 'Mac' } };
    expect(localSignInRequestSchema.parse({ identifier: 'ada', ...rest }).identifier).toBe('ada');
    expect(localSignInRequestSchema.parse({ email: 'a@b.co', ...rest }).email).toBe('a@b.co');
    expect(localSignInRequestSchema.safeParse({ email: 'not-an-email', ...rest }).success).toBe(false);
  });

  it('a newer client reads an older server: the profile fields may be missing', () => {
    const user = { id: 'u', email: 'a@b.co', displayName: 'Ada', serverAdmin: false };
    expect(serverUserSchema.parse(user)).toEqual(user);
    const member = { userId: 'u', email: 'a@b.co', displayName: 'Ada', role: 'member', disabled: false, addedAt: 'x' };
    expect(teamMemberSchema.parse(member)).toEqual(member);
    expect(
      serverUserSchema.parse({
        ...user,
        username: 'ada',
        about: '',
        photo: { version: '0123456789abcdef' },
        cover: null,
      }).photo,
    ).toEqual({ version: '0123456789abcdef' });
  });

  it('an image version is 16 lower-case hex characters', () => {
    expect(imageRefSchema.safeParse({ version: '0123456789abcdef' }).success).toBe(true);
    expect(imageRefSchema.safeParse({ version: '0123456789ABCDEF' }).success).toBe(false);
    expect(imageRefSchema.safeParse({ version: 'short' }).success).toBe(false);
  });

  it('an upload is WebP base64 no longer than the cover cap allows', () => {
    const max = Math.ceil((IMAGE_LIMITS.cover.maxBytes * 4) / 3) + 4;
    expect(imageUploadRequestSchema.safeParse({ contentType: 'image/webp', data: 'AAAA' }).success).toBe(true);
    expect(imageUploadRequestSchema.safeParse({ contentType: 'image/png', data: 'AAAA' }).success).toBe(false);
    expect(imageUploadRequestSchema.safeParse({ contentType: 'image/webp', data: 'A'.repeat(max + 1) }).success).toBe(
      false,
    );
  });
});
