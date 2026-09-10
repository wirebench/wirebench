import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { WssError } from '../../../../src/errors.js';
import {
  keystoreTypeForPath,
  loadKeystore,
  selectAlias,
  toTlsClientIdentity,
} from '../../../../src/wss/keystore/index.js';
import { toKeystoreDef, toKeystoreRef } from '../../../../src/project/keystores.js';
import { generateClientCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore, KeystoreAlias } from '../../../../src/wss/keystore/index.js';

const PASSWORD = 'correct horse';

/** A PKCS#12 holding the client identity, its CA, and the given friendly name. */
function buildPkcs12(options?: { readonly friendlyName?: string; readonly password?: string }): Uint8Array {
  const ca = generateTestCa();
  const client = generateClientCert(ca);
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    forge.pki.privateKeyFromPem(client.keyPem),
    [forge.pki.certificateFromPem(client.certPem), forge.pki.certificateFromPem(ca.certPem)],
    options?.password ?? PASSWORD,
    { friendlyName: options?.friendlyName ?? 'client', algorithm: '3des' },
  );
  return Uint8Array.from(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function errorOf(run: () => unknown): WssError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WssError);
    return error as WssError;
  }
  throw new Error('expected a WssError');
}

describe('keystoreTypeForPath', () => {
  it('infers the container format from the extension', () => {
    expect(keystoreTypeForPath('/tmp/a.P12')).toBe('pkcs12');
    expect(keystoreTypeForPath('/tmp/a.pfx')).toBe('pkcs12');
    expect(keystoreTypeForPath('/tmp/a.pem')).toBe('pem');
    expect(keystoreTypeForPath('/tmp/a.crt')).toBe('pem');
    expect(keystoreTypeForPath('/tmp/a.key')).toBe('pem');
    expect(keystoreTypeForPath('/tmp/a.cer')).toBe('pem');
    expect(keystoreTypeForPath('/tmp/a.jks')).toBeUndefined();
  });
});

describe('loadKeystore (pkcs12)', () => {
  it('lists the client alias with its certificate metadata', () => {
    const keystore = loadKeystore(buildPkcs12(), { type: 'pkcs12', password: PASSWORD });
    expect(keystore.type).toBe('pkcs12');
    const client = keystore.aliases.find((alias) => alias.hasPrivateKey);
    expect(client).toBeDefined();
    expect(client?.alias).toBe('client');
    expect(client?.subject).toContain('CN=wirebench-client');
    expect(client?.issuer).toContain('CN=Wirebench Test CA');
    expect(client?.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(client?.certPem).toContain('BEGIN CERTIFICATE');
    expect(client?.chainPem).toHaveLength(1);
    expect(client?.fingerprintSha256).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    expect(client?.serial).toMatch(/^[0-9A-F]+$/);
    expect(new Date(client?.notAfter ?? '').getTime()).toBeGreaterThan(Date.now());
    expect(new Date(client?.notBefore ?? '').getTime()).toBeLessThan(Date.now());
  });

  it('falls back to the certificate CN when the bag has no friendly name', () => {
    const ca = generateTestCa();
    const client = generateClientCert(ca);
    const asn1 = forge.pkcs12.toPkcs12Asn1(
      forge.pki.privateKeyFromPem(client.keyPem),
      forge.pki.certificateFromPem(client.certPem),
      PASSWORD,
      { algorithm: '3des' },
    );
    const bytes = Uint8Array.from(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));
    const keystore = loadKeystore(bytes, { type: 'pkcs12', password: PASSWORD });
    expect(keystore.aliases[0]?.alias).toBe('wirebench-client');
  });

  it('opens a keystore protected by an empty password', () => {
    const bytes = buildPkcs12({ password: '' });
    expect(loadKeystore(bytes, { type: 'pkcs12' }).aliases.some((alias) => alias.hasPrivateKey)).toBe(true);
    expect(loadKeystore(bytes, { type: 'pkcs12', password: '' }).aliases[0]?.alias).toBe('client');
  });

  it('pairs a key with the certificate it actually signs for, not the first bag', () => {
    // Bag order [ca, leaf] with no `localKeyId`: the only thing that can tell the two apart is
    // the public key, so a bag-order fallback would hand the key the CA's certificate.
    const ca = generateTestCa();
    const client = generateClientCert(ca);
    const asn1 = forge.pkcs12.toPkcs12Asn1(
      forge.pki.privateKeyFromPem(client.keyPem),
      [forge.pki.certificateFromPem(ca.certPem), forge.pki.certificateFromPem(client.certPem)],
      PASSWORD,
      { algorithm: '3des', generateLocalKeyId: false },
    );
    const bytes = Uint8Array.from(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));

    const keystore = loadKeystore(bytes, { type: 'pkcs12', password: PASSWORD });

    const identity = keystore.aliases.find((alias) => alias.hasPrivateKey);
    expect(identity?.certPem.trim()).toBe(client.certPem.trim());
    expect(identity?.subject).toContain('CN=wirebench-client');
  });

  it('rejects a keystore whose key matches none of its certificates', () => {
    const ca = generateTestCa();
    const orphan = generateClientCert(generateTestCa());
    const asn1 = forge.pkcs12.toPkcs12Asn1(
      forge.pki.privateKeyFromPem(orphan.keyPem),
      [forge.pki.certificateFromPem(ca.certPem)],
      PASSWORD,
      { algorithm: '3des', generateLocalKeyId: false },
    );
    const bytes = Uint8Array.from(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));

    const error = errorOf(() => loadKeystore(bytes, { type: 'pkcs12', password: PASSWORD }));

    expect(error.code).toBe('keystore-invalid');
    expect(error.message).toMatch(/matches none of its certificates/);
  });

  it('rejects a wrong password with keystore-bad-password', () => {
    const error = errorOf(() => loadKeystore(buildPkcs12(), { type: 'pkcs12', password: 'nope' }));
    expect(error.code).toBe('keystore-bad-password');
  });

  it('rejects bytes that are not a PKCS#12 file with keystore-invalid', () => {
    const error = errorOf(() => loadKeystore(bytesOf('not a keystore at all'), { type: 'pkcs12' }));
    expect(error.code).toBe('keystore-invalid');
  });

  it('rejects DER that parses but is not a PKCS#12 structure', () => {
    const der = forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, ''));
    const error = errorOf(() =>
      loadKeystore(Uint8Array.from(Buffer.from(der.getBytes(), 'binary')), { type: 'pkcs12' }),
    );
    expect(error.code).toBe('keystore-invalid');
  });
});

describe('loadKeystore (pem)', () => {
  const ca = generateTestCa();
  const client = generateClientCert(ca);

  it('reads a bundle of a leaf, its key and its issuer', () => {
    const keystore = loadKeystore(bytesOf(`${client.certPem}\n${ca.certPem}\n${client.keyPem}`), { type: 'pem' });
    expect(keystore.type).toBe('pem');
    expect(keystore.aliases).toHaveLength(1);
    const alias = keystore.aliases[0];
    expect(alias?.alias).toBe('wirebench-client');
    expect(alias?.hasPrivateKey).toBe(true);
    expect(alias?.chainPem).toHaveLength(1);
    expect(alias?.chainPem[0]).toContain('BEGIN CERTIFICATE');
  });

  it('reads a certificate-only bundle as a trust entry', () => {
    const keystore = loadKeystore(bytesOf(ca.certPem), { type: 'pem' });
    expect(keystore.aliases[0]?.hasPrivateKey).toBe(false);
    expect(keystore.aliases[0]?.keyPem).toBeUndefined();
    expect(keystore.aliases[0]?.alias).toBe('Wirebench Test CA');
  });

  it('decrypts an encrypted key block with the keystore password', () => {
    const encrypted = forge.pki.encryptRsaPrivateKey(forge.pki.privateKeyFromPem(client.keyPem), PASSWORD);
    const keystore = loadKeystore(bytesOf(`${client.certPem}\n${encrypted}`), { type: 'pem', password: PASSWORD });
    expect(keystore.aliases[0]?.keyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('reports keystore-bad-password for an encrypted key with the wrong password', () => {
    const encrypted = forge.pki.encryptRsaPrivateKey(forge.pki.privateKeyFromPem(client.keyPem), PASSWORD);
    expect(
      errorOf(() => loadKeystore(bytesOf(`${client.certPem}\n${encrypted}`), { type: 'pem', password: 'nope' })).code,
    ).toBe('keystore-bad-password');
  });

  it('reports keystore-bad-password for an encrypted key with no password at all', () => {
    const encrypted = forge.pki.encryptRsaPrivateKey(forge.pki.privateKeyFromPem(client.keyPem), PASSWORD);
    expect(errorOf(() => loadKeystore(bytesOf(`${client.certPem}\n${encrypted}`), { type: 'pem' })).code).toBe(
      'keystore-bad-password',
    );
  });

  it('decrypts a legacy Proc-Type: 4,ENCRYPTED RSA key block', () => {
    const encrypted = forge.pki.encryptRsaPrivateKey(forge.pki.privateKeyFromPem(client.keyPem), PASSWORD, {
      legacy: true,
      algorithm: 'aes256',
    });
    expect(encrypted).toContain('Proc-Type: 4,ENCRYPTED');

    const keystore = loadKeystore(bytesOf(`${client.certPem}\n${encrypted}`), { type: 'pem', password: PASSWORD });

    expect(keystore.aliases[0]?.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(keystore.aliases[0]?.hasPrivateKey).toBe(true);
  });

  it('reports keystore-invalid, naming the limitation, for an encrypted non-RSA key', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const encrypted = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: PASSWORD,
    }) as string;

    const error = errorOf(() =>
      loadKeystore(bytesOf(`${client.certPem}\n${encrypted}`), { type: 'pem', password: PASSWORD }),
    );

    expect(error.code).toBe('keystore-invalid');
    expect(error.message).toMatch(/only encrypted RSA keys/i);
  });

  it('reports keystore-invalid when the bundle holds no certificate', () => {
    expect(errorOf(() => loadKeystore(bytesOf(client.keyPem), { type: 'pem' })).code).toBe('keystore-invalid');
    expect(errorOf(() => loadKeystore(bytesOf('garbage'), { type: 'pem' })).code).toBe('keystore-invalid');
  });
});

describe('selectAlias', () => {
  function entry(alias: string, hasPrivateKey: boolean): KeystoreAlias {
    return {
      alias,
      certPem: 'C',
      ...(hasPrivateKey ? { keyPem: 'K' } : {}),
      chainPem: [],
      subject: '',
      issuer: '',
      notBefore: '',
      notAfter: '',
      serial: '',
      fingerprintSha256: '',
      hasPrivateKey,
    };
  }
  const keystore: Keystore = { type: 'pem', aliases: [entry('a', true), entry('ca', false)] };

  it('returns the named alias', () => {
    expect(selectAlias(keystore, 'ca').alias).toBe('ca');
  });

  it('falls back to the only entry with a private key', () => {
    expect(selectAlias(keystore).alias).toBe('a');
  });

  it('reports keystore-alias-missing for an unknown name', () => {
    expect(errorOf(() => selectAlias(keystore, 'nope')).code).toBe('keystore-alias-missing');
  });

  it('reports keystore-alias-missing when nothing is named and several entries qualify', () => {
    const two: Keystore = { type: 'pem', aliases: [entry('a', true), entry('b', true)] };
    expect(errorOf(() => selectAlias(two)).code).toBe('keystore-alias-missing');
  });

  it('reports keystore-alias-missing for an empty keystore', () => {
    expect(errorOf(() => selectAlias({ type: 'pem', aliases: [] })).code).toBe('keystore-alias-missing');
  });

  it('falls back to a certificate-only entry when it is the only one', () => {
    expect(selectAlias({ type: 'pem', aliases: [entry('ca', false)] }).alias).toBe('ca');
  });
});

describe('toTlsClientIdentity', () => {
  it('concatenates the chain after the leaf', () => {
    const keystore = loadKeystore(buildPkcs12(), { type: 'pkcs12', password: PASSWORD });
    const identity = toTlsClientIdentity(keystore, 'client');
    expect(identity.cert.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(identity.key).toContain('BEGIN PRIVATE KEY');
  });

  it('never offers the keystore chain as a trust anchor', () => {
    // `ca` replaces Node's trust store, so a client identity must not carry one: selecting a
    // keystore would otherwise stop every publicly-signed endpoint from verifying.
    const keystore = loadKeystore(buildPkcs12(), { type: 'pkcs12', password: PASSWORD });
    expect(Object.keys(toTlsClientIdentity(keystore, 'client'))).toEqual(['cert', 'key']);
  });

  it('refuses an alias with no private key', () => {
    const ca = generateTestCa();
    const keystore = loadKeystore(bytesOf(ca.certPem), { type: 'pem' });
    expect(errorOf(() => toTlsClientIdentity(keystore)).code).toBe('keystore-invalid');
  });
});

describe('keystore registry refs', () => {
  it('round-trips a definition through a WssRef, preserving unknown fields', () => {
    const ref = toKeystoreRef(
      { id: 'k1', name: 'Client', path: '/tmp/client.p12', type: 'pkcs12', passwordSecretRef: 'ref:1' },
      { id: 'k1', name: 'Client', document: { id: 'k1', name: 'Client', future: 'kept' } },
    );
    expect(ref.document['future']).toBe('kept');
    expect(toKeystoreDef(ref)).toEqual({
      id: 'k1',
      name: 'Client',
      path: '/tmp/client.p12',
      type: 'pkcs12',
      passwordSecretRef: 'ref:1',
    });
  });

  it('drops a cleared password ref and default alias', () => {
    const ref = toKeystoreRef(
      { id: 'k1', name: 'C', path: 'a.pem', type: 'pem' },
      {
        id: 'k1',
        name: 'C',
        document: { id: 'k1', name: 'C', path: 'a.pem', type: 'pem', passwordSecretRef: 'r', defaultAlias: 'x' },
      },
    );
    expect(ref.document['passwordSecretRef']).toBeUndefined();
    expect(ref.document['defaultAlias']).toBeUndefined();
  });

  it('rejects a document that is not a keystore entry', () => {
    expect(() => toKeystoreDef({ id: 'k1', name: 'C', document: { id: 'k1', name: 'C' } })).toThrow(
      /missing a path or type/,
    );
  });
});
