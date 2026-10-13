import { z } from 'zod';

/**
 * Wire shapes of the keychain's SSH keys (#409). The private key never crosses: a passphrase goes to main
 * once, on generate, and what comes back is the public half and the names of the secrets that hold the rest.
 */

export const sshKeyAlgorithmSchema = z.enum(['ed25519', 'ecdsa', 'rsa']);

export const sshGenerateKeyRequestSchema = z.strictObject({
  /** The secret the private key is stored as; its passphrase (if any) goes to `<name>_passphrase`. */
  name: z.string(),
  algorithm: sshKeyAlgorithmSchema,
  /** ECDSA 256/384/521, RSA 2048/3072/4096; main refuses another. Absent: the algorithm's default. */
  bits: z.number().int().optional(),
  /** Absent or blank: `user@host` of this machine. */
  comment: z.string().max(200).optional(),
  passphrase: z.string().optional(),
});

/**
 * The OpenSSH user certificate attached to a key (#421): the `<name>_cert` secret, described. `validity` is as
 * of the listing; `matchesKey` is false when it certifies another key.
 */
export const sshCertificateWireSchema = z.object({
  secret: z.string(),
  keyId: z.string(),
  serial: z.string(),
  /** Empty: any principal. */
  principals: z.array(z.string()),
  /** Milliseconds; null for no bound. */
  validAfter: z.number().nullable(),
  validBefore: z.number().nullable(),
  /** The window in words, in UTC: `from … to …`, `always valid`. */
  window: z.string(),
  validity: z.enum(['valid', 'not-yet-valid', 'expired']),
  caFingerprint: z.string(),
  matchesKey: z.boolean(),
});

/** A secret whose value is a private key. `locked`: encrypted, and its `_passphrase` secret is missing or wrong. */
export const sshKeyWireSchema = z.object({
  name: z.string(),
  locked: z.boolean(),
  keyType: z.string().optional(),
  fingerprint: z.string().optional(),
  /** One OpenSSH `authorized_keys` line. */
  publicKey: z.string().optional(),
  /** The secret that opened it, when it is encrypted. */
  passphraseSecret: z.string().optional(),
  certificate: sshCertificateWireSchema.optional(),
  /** Why its `<name>_cert` secret could not be read as a certificate. */
  certificateError: z.string().optional(),
});
export const sshKeysResponseSchema = z.object({ keys: z.array(sshKeyWireSchema) });

/** Installs the public half of key secret `secret` on host `hostId`, signing in as the host does now. */
export const sshInstallKeyRequestSchema = z.strictObject({ secret: z.string(), hostId: z.string() });
export const sshInstallKeyResponseSchema = z.object({ result: z.enum(['added', 'present']) });

/** Stores `certificate` as `<secret>_cert` after checking that it is a user certificate for that key. */
export const sshAttachCertificateRequestSchema = z.strictObject({
  secret: z.string(),
  certificate: z.string().max(64 * 1024),
});

export type SshKeyAlgorithmWire = z.infer<typeof sshKeyAlgorithmSchema>;
export type SshGenerateKeyRequest = z.infer<typeof sshGenerateKeyRequestSchema>;
export type SshKeyWire = z.infer<typeof sshKeyWireSchema>;
export type SshCertificateWire = z.infer<typeof sshCertificateWireSchema>;
export type SshAttachCertificateRequest = z.infer<typeof sshAttachCertificateRequestSchema>;
export type SshInstallKeyRequest = z.infer<typeof sshInstallKeyRequestSchema>;
export type SshInstallKeyResponse = z.infer<typeof sshInstallKeyResponseSchema>;
