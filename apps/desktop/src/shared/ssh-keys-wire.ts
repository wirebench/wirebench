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
});
export const sshKeysResponseSchema = z.object({ keys: z.array(sshKeyWireSchema) });

/** Installs the public half of key secret `secret` on host `hostId`, signing in as the host does now. */
export const sshInstallKeyRequestSchema = z.strictObject({ secret: z.string(), hostId: z.string() });
export const sshInstallKeyResponseSchema = z.object({ result: z.enum(['added', 'present']) });

export type SshKeyAlgorithmWire = z.infer<typeof sshKeyAlgorithmSchema>;
export type SshGenerateKeyRequest = z.infer<typeof sshGenerateKeyRequestSchema>;
export type SshKeyWire = z.infer<typeof sshKeyWireSchema>;
export type SshInstallKeyRequest = z.infer<typeof sshInstallKeyRequestSchema>;
export type SshInstallKeyResponse = z.infer<typeof sshInstallKeyResponseSchema>;
