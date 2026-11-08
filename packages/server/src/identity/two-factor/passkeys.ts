/**
 * Passkeys as a second factor (two-step sign-in spec §3.5), through `@simplewebauthn/server`: the relying party is
 * the tenant's primary host, and the only origin accepted is its primary URL. Registration asks for user verification
 * when the authenticator can (`preferred`), takes no attestation, and allows ES256 and RS256. Every WebAuthn challenge
 * is used once: a sign-in's lives on its two-factor challenge row and is dropped by any answer; a registration's on a
 * `register` row of the person's, taken by its answer.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { SignInResponse } from '@wirebench/engine';
import type { AuditSource } from '../../context.js';
import type { ModuleConfig } from '../../config.js';
import type { TenantScope } from '../../tenancy/scope.js';
import type { TenantQuerier } from '../../tenancy/tenant-db.js';
import { primaryUrl, type ScopeSource } from '../../tenancy/urls.js';
import type { IdentityEnv } from '../env.js';
import { passkeyFailed } from '../errors.js';
import type * as repo from '../repo.js';
import { mintSecret, newId } from '../tokens.js';
import { CHALLENGE_MS, failedAttempt, finishChallenge } from './gate.js';
import * as twoFactorRepo from './repo.js';

type PasskeyEnv = Pick<IdentityEnv, 'ctx' | 'now' | 'twoFactor'>;

/** ES256 and RS256 (spec §3.5). */
const ALGORITHMS = [-7, -257];

/** The relying party: the tenant's primary host as its id, its primary URL as the one origin (spec §3.5). */
export function relyingParty(config: ModuleConfig, of: ScopeSource): { readonly id: string; readonly origin: string } {
  const origin = primaryUrl(config, of);
  return { id: new URL(origin).hostname, origin };
}

const credentialIdOf = (id: string): Buffer => Buffer.from(id, 'base64url');
const transportsOf = (passkey: twoFactorRepo.PasskeyRow) => passkey.transports as AuthenticatorTransportFuture[];

/** The request options of a sign-in's passkey step, its WebAuthn challenge kept on `row` (spec §3.5). */
export async function signInOptions(
  env: PasskeyEnv,
  scope: TenantScope,
  of: ScopeSource,
  row: twoFactorRepo.ChallengeRow,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const db = env.ctx.tenancy.db(scope);
  const passkeys = await twoFactorRepo.passkeysOf(db, row.userId);
  if (passkeys.length === 0) throw passkeyFailed();
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(env.ctx.config, of).id,
    allowCredentials: passkeys.map((passkey) => ({
      id: passkey.credentialId.toString('base64url'),
      transports: transportsOf(passkey),
    })),
    userVerification: 'preferred',
    timeout: CHALLENGE_MS,
  });
  await twoFactorRepo.setChallengeWebauthn(db, row.id, options.challenge);
  return options;
}

/** A passkey that answered for `row`: the write that records its use, conditional on the counter it was read with. */
type CheckedPasskey = (tx: TenantQuerier) => Promise<boolean>;

/**
 * A passkey's answer to {@link signInOptions}: the session, or a failed attempt. An unknown or another person's
 * credential, a bad signature, another origin and a counter that went backwards all count as a wrong factor, with
 * the reason in the audit log only.
 */
export async function signInWithPasskey(
  env: PasskeyEnv,
  scope: TenantScope,
  of: ScopeSource,
  source: AuditSource,
  row: twoFactorRepo.ChallengeRow,
  response: Record<string, unknown>,
): Promise<SignInResponse> {
  const use = await checkPasskey(env, scope, of, source, row, response);
  return finishChallenge(env, scope, source, row, 'passkey', use);
}

/**
 * The desktop's passkey hand-off (spec §4.2, plan ruling 4): the passkey answered on the browser's page, so instead
 * of a session the challenge gets a one-time grant for the desktop's loopback, which the desktop trades with its PKCE
 * verifier at `/auth/two-factor/passkey/complete`. Answers the grant, kept on the row only as its hash.
 */
export async function grantWithPasskey(
  env: PasskeyEnv,
  scope: TenantScope,
  of: ScopeSource,
  source: AuditSource,
  row: twoFactorRepo.ChallengeRow,
  response: Record<string, unknown>,
): Promise<string> {
  const use = await checkPasskey(env, scope, of, source, row, response);
  const grant = mintSecret();
  const granted = await env.ctx.tenancy.db(scope).transaction(async (tx) => {
    if (!(await use(tx))) return false;
    await twoFactorRepo.setChallengeGrant(tx, row.id, grant.hash);
    return true;
  });
  if (!granted) return failedAttempt(env, scope, source, row, 'passkey', 'replay');
  return grant.secret;
}

async function checkPasskey(
  env: PasskeyEnv,
  scope: TenantScope,
  of: ScopeSource,
  source: AuditSource,
  row: twoFactorRepo.ChallengeRow,
  response: Record<string, unknown>,
): Promise<CheckedPasskey> {
  const db = env.ctx.tenancy.db(scope);
  const expected = row.webauthnChallenge;
  // One answer per options: whatever it is, the WebAuthn challenge is spent.
  await twoFactorRepo.setChallengeWebauthn(db, row.id, null);
  if (expected === null) throw passkeyFailed();
  const answer = response as unknown as AuthenticationResponseJSON;
  const passkey =
    typeof answer.id === 'string'
      ? await twoFactorRepo.passkeyByCredentialId(db, credentialIdOf(answer.id))
      : undefined;
  if (passkey?.userId !== row.userId) return failedAttempt(env, scope, source, row, 'passkey', 'passkey-unknown');
  const rp = relyingParty(env.ctx.config, of);
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response: answer,
      expectedChallenge: expected,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: answer.id,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: transportsOf(passkey),
      },
      requireUserVerification: false,
    });
  } catch (error) {
    // The library names a counter that did not move forward; nothing it says reaches the answer.
    const reason = error instanceof Error && /counter/i.test(error.message) ? 'passkey-counter' : 'passkey-invalid';
    return failedAttempt(env, scope, source, row, 'passkey', reason);
  }
  if (!verified.verified) return failedAttempt(env, scope, source, row, 'passkey', 'passkey-invalid');
  const counter = verified.authenticationInfo.newCounter;
  return (tx) => twoFactorRepo.usePasskey(tx, passkey.id, passkey.counter, counter, env.now());
}

/** The creation options of a new passkey for `user` (spec §5.2), its WebAuthn challenge on a `register` row. */
export async function registrationOptions(
  env: Pick<IdentityEnv, 'ctx' | 'now'>,
  scope: TenantScope,
  of: ScopeSource,
  user: repo.UserRow,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const db = env.ctx.tenancy.db(scope);
  const passkeys = await twoFactorRepo.passkeysOf(db, user.id);
  const options = await generateRegistrationOptions({
    rpName: 'Wirebench',
    rpID: relyingParty(env.ctx.config, of).id,
    userName: user.email,
    userDisplayName: user.displayName,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: passkeys.map((passkey) => ({
      id: passkey.credentialId.toString('base64url'),
      transports: transportsOf(passkey),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    supportedAlgorithmIDs: ALGORITHMS,
    timeout: CHALLENGE_MS,
  });
  const at = env.now();
  await twoFactorRepo.replaceRegisterChallenge(db, {
    id: newId(),
    userId: user.id,
    secretHash: mintSecret().hash,
    webauthnChallenge: options.challenge,
    at,
    expiresAt: new Date(at.getTime() + CHALLENGE_MS),
  });
  return options;
}

export interface VerifiedPasskey {
  readonly credentialId: Buffer;
  readonly publicKey: Buffer;
  readonly counter: number;
  readonly transports: readonly string[];
}

/**
 * The browser's answer to {@link registrationOptions}, checked against the person's live registration challenge,
 * which it takes; `identity-passkey-failed` for anything that does not verify.
 */
export async function verifyNewPasskey(
  env: Pick<IdentityEnv, 'ctx' | 'now'>,
  scope: TenantScope,
  of: ScopeSource,
  userId: string,
  response: Record<string, unknown>,
): Promise<VerifiedPasskey> {
  const expected = await twoFactorRepo.takeRegisterChallenge(env.ctx.tenancy.db(scope), userId, env.now());
  if (expected === undefined) throw passkeyFailed();
  const rp = relyingParty(env.ctx.config, of);
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: expected,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
      supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch {
    throw passkeyFailed();
  }
  if (!verified.verified) throw passkeyFailed();
  const credential = verified.registrationInfo.credential;
  return {
    credentialId: credentialIdOf(credential.id),
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
  };
}
