import {
  devicesResponseSchema,
  rememberedAccountsResponseSchema,
  identityIdParamsSchema,
  meResponseSchema,
  isValidUsername,
  MAX_ABOUT_LENGTH,
  meUpdateRequestSchema,
  MIN_PASSWORD_LENGTH,
  passwordChangeRequestSchema,
  type MeUpdateRequest,
  type PasswordChangeRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { announce, auditSource, recordAudit } from '../../context.js';
import { isUsernameTaken } from '../../db/errors.js';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import {
  aboutInvalid,
  browserOnly,
  displayNameInvalid,
  invalidCredentials,
  methodDisabled,
  notFound,
  passwordTooShort,
  unauthenticated,
  updateEmpty,
  usernameInvalid,
  usernameTaken,
} from '../errors.js';
import { isTokenExpired, requireUser } from '../guard.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { profileLimit } from '../profile-limit.js';
import * as repo from '../repo.js';
import { presentedSessions, writeRemembered } from '../remembered.js';
import { imageRef, publicUser } from '../sessions.js';

/**
 * The about text as stored (ruling 13): line breaks folded to `\n`, every other control character dropped, then
 * trimmed. It is shown as text everywhere, so nothing else is changed.
 */
export function cleanAbout(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n]/gu, '')
    .trim();
}

export const meRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get(
      '/me',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(meResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        // One unit for the user and their methods.
        return env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
          const user = await repo.findUserById(tx, caller.id);
          if (user === undefined) throw unauthenticated();
          const methods = (await repo.signInMethodsOf(tx, [user.id])).get(user.id)!;
          return { user: publicUser(user), methods };
        });
      },
    );

    // The other accounts this browser holds (switch accounts spec §5.5), people and never tokens. A remembered session
    // that ended (revoked, expired, its user disabled or removed) is left out and dropped from the cookie.
    app.get(
      '/me/accounts',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(rememberedAccountsResponseSchema) } } },
      async (request, reply) => {
        if (request.caller!.via !== 'cookie') throw browserOnly();
        const presented = await presentedSessions(env, request);
        if (presented.stale) writeRemembered(env, request, reply, presented.remembered);
        reply.header('cache-control', 'no-store');
        return presented.remembered.map(({ user }) => ({
          userId: user.id,
          displayName: user.displayName,
          email: user.email,
          username: user.username,
          photo: imageRef(user.photo),
        }));
      },
    );

    app.patch(
      '/me',
      {
        preHandler: [requireUser, profileLimit(env, 'changes')],
        schema: {
          body: jsonSchema(meUpdateRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(meResponseSchema) },
        },
      },
      async (request) => {
        const caller = request.caller!;
        const body = request.body as MeUpdateRequest;
        if (body.name === undefined && body.username === undefined && body.about === undefined) throw updateEmpty();
        const name = body.name === undefined ? undefined : body.name.trim();
        if (name === '') throw displayNameInvalid();
        // `null` clears the username, and so does an empty one: the body's schema may hand a JSON null over as ''.
        // Spec §2: typed in any case, stored lower-case, so `@Ada` and `@ada` are one name everywhere it shows.
        const username = body.username === undefined ? undefined : (body.username ?? '').trim().toLowerCase() || null;
        if (typeof username === 'string' && !isValidUsername(username)) throw usernameInvalid(username);
        const about = body.about === undefined ? undefined : cleanAbout(body.about);
        if (about !== undefined && about.length > MAX_ABOUT_LENGTH) throw aboutInvalid();
        return env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
          const user = await repo.findUserById(tx, caller.id);
          if (user === undefined) throw unauthenticated();
          // Only what differs is written and named (ruling 5): an unchanged field is no change.
          const changes: { displayName?: string; username?: string | null; about?: string } = {};
          if (name !== undefined && name !== user.displayName) changes.displayName = name;
          if (username !== undefined && username?.toLowerCase() !== user.username?.toLowerCase()) {
            if (username !== null) {
              const holder = await repo.findUserByUsername(tx, username.toLowerCase());
              if (holder !== undefined && holder.id !== user.id) throw usernameTaken();
            }
            changes.username = username;
          }
          if (about !== undefined && about !== user.about) changes.about = about;
          const fields = Object.keys(changes);
          if (fields.length > 0) {
            try {
              await repo.setProfile(tx, user.id, changes);
            } catch (error) {
              // Two people claiming one free name at once: the second meets the unique key.
              if (isUsernameTaken(error)) throw usernameTaken();
              throw error;
            }
            // The names of what changed, never the values (spec §9).
            await recordAudit(env.ctx.hooks, tx, {
              ...auditSource(request),
              action: 'user.updated',
              target: { kind: 'user', id: user.id },
              details: { fields, via: 'self' },
            });
          }
          const methods = (await repo.signInMethodsOf(tx, [user.id])).get(user.id)!;
          return { user: publicUser({ ...user, ...changes }), methods };
        });
      },
    );

    app.post(
      '/me/password',
      { preHandler: requireUser, schema: { body: jsonSchema(passwordChangeRequestSchema, { io: 'input' }) } },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const caller = request.caller!;
        const body = request.body as PasswordChangeRequest;
        if (body.newPassword.length < MIN_PASSWORD_LENGTH) throw passwordTooShort();
        const db = env.ctx.tenancy.db(request.tenant);
        const credential = await repo.credentialOf(db, caller.id);
        if (credential !== undefined) {
          const current =
            body.currentPassword === undefined
              ? undefined
              : await verifyPassword(body.currentPassword, credential.passwordHash);
          if (current?.ok !== true) throw invalidCredentials();
        }
        const hash = await hashPassword(body.newPassword);
        const now = env.now();
        await db.transaction(async (tx) => {
          await repo.upsertCredential(tx, caller.id, hash, now);
          await repo.revokeTokensOfUser(tx, caller.id, now, caller.tokenId); // every *other* device (§3.1)
          await recordAudit(env.ctx.hooks, tx, {
            ...auditSource(request),
            action: 'auth.password_changed',
            target: { kind: 'user', id: caller.id },
            details: { via: 'self' },
          });
        });
        // The device that changed the password keeps its sockets, as it keeps its token.
        announce(
          env.ctx.hooks.sessionEnded,
          { tenantId: request.tenant.tenantId, userId: caller.id, exceptTokenId: caller.tokenId },
          request.log,
        );
        return reply.code(204).send();
      },
    );

    app.get(
      '/me/devices',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(devicesResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        const now = env.now();
        return (await repo.tokensOfUser(env.ctx.tenancy.db(request.tenant), caller.id))
          .filter((token) => !isTokenExpired(token, now, env.settings))
          .map((token) => ({
            id: token.id,
            name: token.deviceName,
            createdAt: token.createdAt,
            lastUsedAt: token.lastUsedAt,
            current: token.id === caller.tokenId,
          }));
      },
    );

    app.delete(
      '/me/devices/:id',
      { preHandler: requireUser, schema: { params: jsonSchema(identityIdParamsSchema, { io: 'input' }) } },
      async (request, reply) => {
        const caller = request.caller!;
        const { id } = request.params as { id: string };
        const db = env.ctx.tenancy.db(request.tenant);
        const owned = (await repo.tokensOfUser(db, caller.id)).some((token) => token.id === id);
        if (!owned) throw notFound('Device');
        await db.transaction(async (tx) => {
          await repo.revokeToken(tx, id, env.now());
          await recordAudit(env.ctx.hooks, tx, {
            ...auditSource(request),
            action: 'auth.signed_out',
            target: { kind: 'user', id: caller.id },
            details: { tokenId: id },
          });
        });
        announce(env.ctx.hooks.sessionEnded, { tenantId: request.tenant.tenantId, tokenId: id }, request.log);
        return reply.code(204).send();
      },
    );
  };
