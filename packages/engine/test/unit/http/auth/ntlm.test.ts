import { describe, expect, it } from 'vitest';
import {
  AV_IDS,
  DEFAULT_NEGOTIATE_FLAGS,
  NTLM_FLAGS,
  buildAvPairs,
  createType1,
  createType3,
  encodeNtlmAuthorization,
  lmv2Response,
  ntProofString,
  ntlmv2Blob,
  ntowfv2,
  offersNtlm,
  parseAvPairs,
  parseNtlmChallengeHeader,
  parseType2,
  parseType3,
  toFileTime,
} from '../../../../src/http/auth/ntlm.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const bytes = (hexString: string): Uint8Array => new Uint8Array(Buffer.from(hexString, 'hex'));
const utf16 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf16le'));

// ---------------------------------------------------------------------------
// MS-NLMP §4.2.4 — "NTLMv2 Authentication" test values.
// User "User", domain "Domain", password "Password", server "Server";
// client challenge aaaaaaaaaaaaaaaa, server challenge 0123456789abcdef, time 0.
// ---------------------------------------------------------------------------
const V = {
  user: 'User',
  domain: 'Domain',
  password: 'Password',
  serverChallenge: bytes('0123456789abcdef'),
  clientChallenge: bytes('aaaaaaaaaaaaaaaa'),
  timestamp: 0n,
  /** §4.2.4.1.3: MsvAvNbDomainName "Domain", MsvAvNbComputerName "Server", MsvAvEOL. */
  targetInfo: buildAvPairs([
    { id: AV_IDS.MsvAvNbDomainName, value: utf16('Domain') },
    { id: AV_IDS.MsvAvNbComputerName, value: utf16('Server') },
  ]),
} as const;

describe('NTLMv2 cryptography (MS-NLMP §4.2.4 vectors)', () => {
  it('derives NTOWFv2', () => {
    expect(hex(ntowfv2(V.user, V.domain, V.password))).toBe('0c868a403bfd7a93a3001ef22ef02e3f');
  });

  it('upper-cases only the user name, not the domain', () => {
    expect(hex(ntowfv2('user', V.domain, V.password))).toBe(hex(ntowfv2('USER', V.domain, V.password)));
    expect(hex(ntowfv2(V.user, 'DOMAIN', V.password))).not.toBe(hex(ntowfv2(V.user, V.domain, V.password)));
  });

  it('computes NTProofStr from the temp blob', () => {
    const blob = ntlmv2Blob({
      timestamp: V.timestamp,
      clientChallenge: V.clientChallenge,
      targetInfo: V.targetInfo,
    });
    const proof = ntProofString(ntowfv2(V.user, V.domain, V.password), V.serverChallenge, blob);
    expect(hex(proof)).toBe('68cd0ab851e51c96aabc927bebef6a1c');
  });

  it('computes the LMv2 response', () => {
    const lm = lmv2Response(ntowfv2(V.user, V.domain, V.password), V.serverChallenge, V.clientChallenge);
    expect(hex(lm)).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa');
  });

  it('lays the temp blob out as version || Z(6) || timestamp || clientChallenge || Z(4) || AV || Z(4)', () => {
    const blob = ntlmv2Blob({ timestamp: 0n, clientChallenge: V.clientChallenge, targetInfo: V.targetInfo });
    expect(hex(blob.slice(0, 8))).toBe('0101000000000000');
    expect(hex(blob.slice(8, 16))).toBe('0000000000000000');
    expect(hex(blob.slice(16, 24))).toBe('aaaaaaaaaaaaaaaa');
    expect(hex(blob.slice(24, 28))).toBe('00000000');
    expect(hex(blob.slice(28, 28 + V.targetInfo.length))).toBe(hex(V.targetInfo));
    expect(hex(blob.slice(28 + V.targetInfo.length))).toBe('00000000');
  });
});

describe('toFileTime', () => {
  it('converts the Unix epoch to the Windows FILETIME epoch offset', () => {
    expect(toFileTime(0)).toBe(116444736000000000n);
    expect(toFileTime(1000)).toBe(116444736010000000n);
  });
});

describe('AV pairs', () => {
  it('round-trips through build and parse, terminated by MsvAvEOL', () => {
    const built = buildAvPairs([
      { id: AV_IDS.MsvAvNbDomainName, value: utf16('Domain') },
      { id: AV_IDS.MsvAvTimestamp, value: bytes('0102030405060708') },
    ]);
    expect(hex(built.slice(-4))).toBe('00000000');
    const parsed = parseAvPairs(built);
    expect(parsed.map((pair) => pair.id)).toEqual([AV_IDS.MsvAvNbDomainName, AV_IDS.MsvAvTimestamp]);
    expect(Buffer.from(parsed[1]?.value ?? new Uint8Array()).toString('hex')).toBe('0102030405060708');
  });

  it('stops at a truncated pair rather than throwing', () => {
    expect(parseAvPairs(bytes('0200ff00'))).toEqual([]);
  });
});

describe('createType1', () => {
  it('emits a signature, message type 1 and the default flags', () => {
    const message = createType1();
    expect(Buffer.from(message.slice(0, 8)).toString('latin1')).toBe('NTLMSSP\0');
    const view = new DataView(message.buffer);
    expect(view.getUint32(8, true)).toBe(1);
    expect(view.getUint32(12, true) >>> 0).toBe(DEFAULT_NEGOTIATE_FLAGS);
    expect(DEFAULT_NEGOTIATE_FLAGS & NTLM_FLAGS.NEGOTIATE_EXTENDED_SESSIONSECURITY).toBeTruthy();
    expect(DEFAULT_NEGOTIATE_FLAGS & NTLM_FLAGS.NEGOTIATE_UNICODE).toBeTruthy();
    expect(message).toHaveLength(40);
  });

  it('carries an OEM, upper-cased domain and workstation with the supplied flags', () => {
    const message = createType1({ domain: 'corp', workstation: 'ws1' });
    const view = new DataView(message.buffer);
    const flags = view.getUint32(12, true) >>> 0;
    expect(flags & NTLM_FLAGS.NEGOTIATE_OEM_DOMAIN_SUPPLIED).toBeTruthy();
    expect(flags & NTLM_FLAGS.NEGOTIATE_OEM_WORKSTATION_SUPPLIED).toBeTruthy();
    expect(Buffer.from(message.slice(40, 44)).toString('latin1')).toBe('CORP');
    expect(Buffer.from(message.slice(44, 47)).toString('latin1')).toBe('WS1');
  });

  it('honours an explicit flag override', () => {
    const message = createType1({ flags: NTLM_FLAGS.NEGOTIATE_UNICODE });
    expect(new DataView(message.buffer).getUint32(12, true)).toBe(NTLM_FLAGS.NEGOTIATE_UNICODE);
  });
});

/** Builds a Type 2 message the way a server would, so `parseType2` has real bytes to read. */
function buildType2(params: {
  targetName: string;
  serverChallenge: Uint8Array;
  targetInfo: Uint8Array;
  flags?: number;
}): Uint8Array {
  const targetName = utf16(params.targetName);
  const header = 56;
  const message = new Uint8Array(header + targetName.length + params.targetInfo.length);
  message.set(new Uint8Array(Buffer.from('NTLMSSP\0', 'latin1')), 0);
  const view = new DataView(message.buffer);
  view.setUint32(8, 2, true);
  view.setUint16(12, targetName.length, true);
  view.setUint16(14, targetName.length, true);
  view.setUint32(16, header, true);
  view.setUint32(20, params.flags ?? DEFAULT_NEGOTIATE_FLAGS, true);
  message.set(params.serverChallenge, 24);
  view.setUint16(40, params.targetInfo.length, true);
  view.setUint16(42, params.targetInfo.length, true);
  view.setUint32(44, header + targetName.length, true);
  message.set(bytes('0601b11d0000000f'), 48);
  message.set(targetName, header);
  message.set(params.targetInfo, header + targetName.length);
  return message;
}

describe('parseType2', () => {
  const message = buildType2({
    targetName: 'DOMAIN',
    serverChallenge: V.serverChallenge,
    targetInfo: V.targetInfo,
  });

  it('reads the challenge, target name, target info and version', () => {
    const type2 = parseType2(message);
    expect(hex(type2.serverChallenge)).toBe('0123456789abcdef');
    expect(type2.targetName).toBe('DOMAIN');
    expect(hex(type2.targetInfo)).toBe(hex(V.targetInfo));
    expect(hex(type2.version ?? new Uint8Array())).toBe('0601b11d0000000f');
    expect(type2.flags >>> 0).toBe(DEFAULT_NEGOTIATE_FLAGS);
  });

  it('decodes an OEM target name when Unicode is not negotiated', () => {
    const oem = new Uint8Array(56 + 6);
    oem.set(new Uint8Array(Buffer.from('NTLMSSP\0', 'latin1')), 0);
    const view = new DataView(oem.buffer);
    view.setUint32(8, 2, true);
    view.setUint16(12, 6, true);
    view.setUint32(16, 56, true);
    view.setUint32(20, NTLM_FLAGS.NEGOTIATE_OEM, true);
    oem.set(new Uint8Array(Buffer.from('DOMAIN', 'latin1')), 56);
    expect(parseType2(oem).targetName).toBe('DOMAIN');
  });

  it('rejects a non-NTLM payload and a wrong message type', () => {
    expect(() => parseType2(bytes('00'.repeat(40)))).toThrow(/not an NTLM message/);
    const wrongType = Uint8Array.from(message);
    new DataView(wrongType.buffer).setUint32(8, 1, true);
    expect(() => parseType2(wrongType)).toThrow(/Type 2/);
  });
});

describe('createType3 / parseType3', () => {
  const type2 = parseType2(
    buildType2({ targetName: 'Domain', serverChallenge: V.serverChallenge, targetInfo: V.targetInfo }),
  );

  it('produces a response an independent verifier accepts', () => {
    const result = createType3({
      username: V.user,
      password: V.password,
      domain: V.domain,
      workstation: 'CLIENT',
      type2,
      clientChallenge: V.clientChallenge,
      timestamp: V.timestamp,
    });

    const parsed = parseType3(result.message);
    expect(parsed.username).toBe('User');
    expect(parsed.domain).toBe('Domain');
    expect(parsed.workstation).toBe('CLIENT');
    expect(hex(parsed.lmChallengeResponse)).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa');

    // Verify the way a server does: split proof from blob, recompute the HMAC over the blob as sent.
    const proof = parsed.ntChallengeResponse.slice(0, 16);
    const blob = parsed.ntChallengeResponse.slice(16);
    const expected = ntProofString(ntowfv2(parsed.username, parsed.domain, V.password), V.serverChallenge, blob);
    expect(hex(proof)).toBe(hex(expected));
    expect(hex(proof)).toBe(hex(result.ntProofStr));
  });

  it('fails verification under a wrong password', () => {
    const result = createType3({
      username: V.user,
      password: 'wrong',
      domain: V.domain,
      type2,
      clientChallenge: V.clientChallenge,
      timestamp: V.timestamp,
    });
    const parsed = parseType3(result.message);
    const blob = parsed.ntChallengeResponse.slice(16);
    const expected = ntProofString(ntowfv2(V.user, V.domain, V.password), V.serverChallenge, blob);
    expect(hex(parsed.ntChallengeResponse.slice(0, 16))).not.toBe(hex(expected));
  });

  it('carries the server AV pairs through and appends a timestamp and MsvAvFlags', () => {
    const result = createType3({
      username: V.user,
      password: V.password,
      type2,
      clientChallenge: V.clientChallenge,
      timestamp: 132_000_000_000_000_000n,
    });
    const pairs = parseAvPairs(result.ntChallengeResponse.slice(16 + 28, result.ntChallengeResponse.length - 4));
    expect(pairs.map((pair) => pair.id)).toEqual([
      AV_IDS.MsvAvNbDomainName,
      AV_IDS.MsvAvNbComputerName,
      AV_IDS.MsvAvTimestamp,
      AV_IDS.MsvAvFlags,
    ]);
    // MsvAvFlags = 0: no MIC is present. (Bit 0x02 would claim one.)
    expect(hex(pairs[3]?.value ?? new Uint8Array())).toBe('00000000');
    expect(hex(pairs[2]?.value ?? new Uint8Array())).toBe('00005af64cf5d401');
  });

  it('keeps a server-supplied MsvAvTimestamp instead of adding a second one', () => {
    const withTimestamp = parseType2(
      buildType2({
        targetName: 'Domain',
        serverChallenge: V.serverChallenge,
        targetInfo: buildAvPairs([
          { id: AV_IDS.MsvAvNbDomainName, value: utf16('Domain') },
          { id: AV_IDS.MsvAvTimestamp, value: bytes('0807060504030201') },
        ]),
      }),
    );
    const result = createType3({
      username: V.user,
      password: V.password,
      type2: withTimestamp,
      clientChallenge: V.clientChallenge,
      timestamp: 1n,
    });
    const pairs = parseAvPairs(result.ntChallengeResponse.slice(16 + 28, result.ntChallengeResponse.length - 4));
    expect(pairs.filter((pair) => pair.id === AV_IDS.MsvAvTimestamp)).toHaveLength(1);
  });

  it('rejects a non-Type-3 payload', () => {
    expect(() => parseType3(bytes('00'.repeat(72)))).toThrow(/not an NTLM message/);
    expect(() => parseType3(createType1())).toThrow(/not an NTLM message/);
  });
});

describe('header encoding', () => {
  it('encodes an Authorization value', () => {
    expect(encodeNtlmAuthorization(bytes('4e544c4d5353500001000000'))).toBe('NTLM TlRMTVNTUAABAAAA');
  });

  it('extracts an NTLM challenge', () => {
    const message = buildType2({ targetName: 'X', serverChallenge: V.serverChallenge, targetInfo: V.targetInfo });
    const header = `NTLM ${Buffer.from(message).toString('base64')}`;
    expect(hex(parseNtlmChallengeHeader(header) ?? new Uint8Array())).toBe(hex(message));
  });

  it('accepts an NTLMSSP payload advertised as Negotiate', () => {
    const message = buildType2({ targetName: 'X', serverChallenge: V.serverChallenge, targetInfo: V.targetInfo });
    const header = `Negotiate ${Buffer.from(message).toString('base64')}`;
    expect(parseNtlmChallengeHeader(header)).toBeDefined();
  });

  it('ignores a Negotiate token that is not NTLMSSP, and a bare NTLM challenge', () => {
    expect(parseNtlmChallengeHeader(`Negotiate ${Buffer.from('YIIF...kerberos').toString('base64')}`)).toBeUndefined();
    expect(parseNtlmChallengeHeader('NTLM')).toBeUndefined();
    expect(parseNtlmChallengeHeader('Basic realm="x"')).toBeUndefined();
    expect(parseNtlmChallengeHeader(undefined)).toBeUndefined();
  });

  it('finds the NTLM challenge among several in one header', () => {
    const message = buildType2({ targetName: 'X', serverChallenge: V.serverChallenge, targetInfo: V.targetInfo });
    const header = `Basic realm="x", NTLM ${Buffer.from(message).toString('base64')}`;
    expect(parseNtlmChallengeHeader(header)).toBeDefined();
  });

  it('detects a bare NTLM/Negotiate offer', () => {
    expect(offersNtlm('NTLM')).toBe(true);
    expect(offersNtlm('Basic realm="x", Negotiate')).toBe(true);
    expect(offersNtlm('Basic realm="x"')).toBe(false);
    expect(offersNtlm(undefined)).toBe(false);
  });
});
