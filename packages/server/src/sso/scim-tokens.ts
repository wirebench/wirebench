/**
 * SCIM bearer tokens (saml-scim spec §3.4, §6.2). A token is `wbscim_` + base64url(32 bytes), shown once
 * and stored as its SHA-256. The prefix differs from a device token's, so neither guard ever accepts the
 * other. The API routes and the CLI share these functions, so both record the same audit events.
 */
import { randomBytes } from 'node:crypto';
import { SCIM_TOKEN_NAME_MAX_LENGTH, type ScimTokenCreated, type ScimTokenSummary } from '@wirebench/engine';
import { recordAudit, type AuditSource, type ServerContext } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
import { hashSecret, newId } from '../identity/tokens.js';
import { problem } from '../problem.js';
import type { TenantScope } from '../tenancy/scope.js';
import * as repo from './repo.js';

export const SCIM_TOKEN_PREFIX = 'wbscim_';
const NAME_INDEX = 'scim_tokens_name_lower';

export interface ScimTokenEnv {
  readonly ctx: Pick<ServerContext, 'tenancy' | 'hooks'>;
  readonly now: () => Date;
}

export const scimTokenNameInvalid = () =>
  problem(
    'invalid-request',
    `A SCIM token needs a name of 1 to ${String(SCIM_TOKEN_NAME_MAX_LENGTH)} characters.`,
    400,
  );
export const scimTokenNameTaken = (name: string) =>
  problem('sso-scim-token-name-taken', `A SCIM token named "${name}" already exists.`, 409);
export const scimTokenNotFound = () => problem('sso-scim-token-not-found', 'That SCIM token was not found.', 404);

export function mintScimToken(): { readonly token: string; readonly hash: string } {
  const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashSecret(token) };
}

export function scimTokenSummary(row: repo.ScimTokenRow): ScimTokenSummary {
  return { id: row.id, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

/** Creates a token named `rawName` (trimmed); the answer is the only place the token ever appears. */
export async function createScimToken(
  env: ScimTokenEnv,
  scope: TenantScope,
  rawName: string,
  createdBy: string | null,
  source: AuditSource,
): Promise<ScimTokenCreated> {
  const name = rawName.trim();
  if (name.length === 0 || name.length > SCIM_TOKEN_NAME_MAX_LENGTH) throw scimTokenNameInvalid();
  const minted = mintScimToken();
  const id = newId();
  try {
    const row = await env.ctx.tenancy.db(scope).transaction(async (tx) => {
      const inserted = await repo.insertScimToken(tx, { id, name, tokenHash: minted.hash, createdBy, at: env.now() });
      await recordAudit(env.ctx.hooks, tx, {
        ...source,
        action: 'scim.token_created',
        target: { kind: 'scim-token', id },
        details: { name },
      });
      return inserted;
    });
    return { id, name, token: minted.token, createdAt: row.createdAt };
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) throw scimTokenNameTaken(name);
    throw error;
  }
}

/** Revokes a live token; a token already revoked, or unknown, is `scimTokenNotFound`. */
export async function revokeScimToken(
  env: ScimTokenEnv,
  scope: TenantScope,
  id: string,
  source: AuditSource,
): Promise<void> {
  await env.ctx.tenancy.db(scope).transaction(async (tx) => {
    const row = await repo.scimTokenById(tx, id);
    if (row === undefined || !(await repo.revokeScimToken(tx, id, env.now()))) throw scimTokenNotFound();
    await recordAudit(env.ctx.hooks, tx, {
      ...source,
      action: 'scim.token_revoked',
      target: { kind: 'scim-token', id },
      details: { name: row.name },
    });
  });
}
