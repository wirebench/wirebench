import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildUsernameToken, passwordDigest } from '../../../../src/wss/outgoing/username-token.js';
import { serializeXml } from '../../../../src/xml/serialize.js';

const NONCE_BASE64 = 'WScqanjCEAC4mQoBE07sAQ==';
const CREATED = '2003-07-16T01:24:32Z';
const PASSWORD = 'IlovePython';
// Base64(SHA-1(nonce ‖ created ‖ password)) for the inputs above, computed from the
// definition below as well as pinned here. (The digest literal quoted in the task brief,
// `tuOSpGlFlIXsozq4HFNeeGeFLEI=`, does not reproduce from those inputs under any ordering —
// like the WSS specification's own example it is inconsistent with the formula it illustrates.)
const EXPECTED_DIGEST = 'FjH9E14Y27bd5OrmN7pJveDdItU=';

const NONCE = () => new Uint8Array(Buffer.from(NONCE_BASE64, 'base64'));
const CLOCK = () => new Date(CREATED);
const UUID = () => 'abc';

describe('passwordDigest', () => {
  it('matches the UsernameToken Profile vector', () => {
    const nonce = Buffer.from(NONCE_BASE64, 'base64');
    // Computed independently here as well as asserted against the literal, so the vector is
    // pinned by both the specification's value and its definition.
    const computed = createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(CREATED, 'utf8'), Buffer.from(PASSWORD, 'utf8')]))
      .digest('base64');
    expect(computed).toBe(EXPECTED_DIGEST);
    expect(passwordDigest(new Uint8Array(nonce), CREATED, PASSWORD)).toBe(EXPECTED_DIGEST);
  });
});

describe('buildUsernameToken', () => {
  it('writes a PasswordDigest token with nonce and created', () => {
    const element = buildUsernameToken({
      username: 'bob',
      password: PASSWORD,
      passwordType: 'digest',
      addNonce: false,
      addCreated: false,
      clock: CLOCK,
      nonce: NONCE,
      uuid: UUID,
    });
    const xml = serializeXml(element);
    expect(xml).toContain('<wsse:Username>bob</wsse:Username>');
    expect(xml).toContain(
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' +
        `${EXPECTED_DIGEST}</wsse:Password>`,
    );
    // digest forces nonce + created on even when the entry disabled them
    expect(xml).toContain(`>${NONCE_BASE64}</wsse:Nonce>`);
    expect(xml).toContain(`<wsu:Created>${CREATED}</wsu:Created>`);
    expect(xml).toContain('wsu:Id="UsernameToken-abc"');
  });

  it('writes a PasswordText token', () => {
    const xml = serializeXml(
      buildUsernameToken({
        username: 'bob',
        password: PASSWORD,
        passwordType: 'text',
        addNonce: false,
        addCreated: false,
        clock: CLOCK,
        nonce: NONCE,
        uuid: UUID,
      }),
    );
    expect(xml).toContain(
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">' +
        `${PASSWORD}</wsse:Password>`,
    );
    expect(xml).not.toContain('Nonce');
    expect(xml).not.toContain('Created');
  });

  it('omits the password entirely for passwordType none, keeping requested nonce and created', () => {
    const xml = serializeXml(
      buildUsernameToken({
        username: 'bob',
        passwordType: 'none',
        addNonce: true,
        addCreated: true,
        clock: CLOCK,
        nonce: NONCE,
        uuid: UUID,
      }),
    );
    expect(xml).not.toContain('Password');
    expect(xml).toContain(
      '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">',
    );
    expect(xml).toContain(`<wsu:Created>${CREATED}</wsu:Created>`);
  });

  it('treats a missing password as an empty one', () => {
    const xml = serializeXml(
      buildUsernameToken({
        username: 'bob',
        passwordType: 'text',
        addNonce: false,
        addCreated: false,
        clock: CLOCK,
        nonce: NONCE,
        uuid: UUID,
      }),
    );
    expect(xml).toContain('#PasswordText"/>');
  });
});
