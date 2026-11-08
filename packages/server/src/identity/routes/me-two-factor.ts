/**
 * A person's own two-step sign-in (spec §5, §7), the authenticator and recovery codes; passkeys add their routes
 * apart. Every change asks for the current password first, except under the setup challenge of §4.3, which reaches
 * `POST /me/two-factor/totp` and its confirm only. An admin's reset is `DELETE /users/:id/two-factor`.
 */
import {
  identityIdParamsSchema,
  MAX_PASSKEYS,
  passkeyAddRequestSchema,
  passkeyAddResponseSchema,
  passkeyRenameRequestSchema,
  webauthnJsonSchema,
  type PasskeyAddRequest,
  type PasskeyRenameRequest,
  recoveryCodesResponseSchema,
  reauthRequestSchema,
  totpConfirmRequestSchema,
  totpConfirmResponseSchema,
  totpSetupRequestSchema,
  totpSetupResponseSchema,
  twoFactorSetupSignInResponseSchema,
  twoFactorStatusSchema,
  type ReauthRequest,
  type TotpConfirmRequest,
  type TotpSetupRequest,
  type TwoFactorStatus,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { renderSVG } from 'uqr';
import { auditSource, recordAudit } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import { primaryUrl } from '../../tenancy/urls.js';
import type { IdentityEnv } from '../env.js';
import {
  displayNameInvalid,
  notFound,
  passkeyFailed,
  passkeyLimit,
  twoFactorExists,
  twoFactorExpired,
  twoFactorInvalid,
  twoFactorOff,
  twoFactorSetupExpired,
  userDisabled,
} from '../errors.js';
import { requireUser } from '../guard.js';
import * as repo from '../repo.js';
import { issueSession, PENDING_TOTP_MS } from '../sessions.js';
import {
  credentialFor,
  issueRecoveryCodes,
  methodAdded,
  methodRemoved,
  reauthenticate,
  selfEvent,
  subjectOf,
} from '../two-factor/enrol.js';
import { charge, personKey } from '../two-factor/gate.js';
import { openTotpSecret, sealTotpSecret } from '../two-factor/keys.js';
import { registrationOptions, verifyNewPasskey } from '../two-factor/passkeys.js';
import { newId } from '../tokens.js';
import * as twoFactorRepo from '../two-factor/repo.js';
import { twoFactorRequired } from '../two-factor/required.js';
import { base32, newTotpSecret, otpauthUri, verifyTotp } from '../two-factor/totp.js';

export const meTwoFactorRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get(
      '/me/two-factor',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(twoFactorStatusSchema) } } },
      async (request): Promise<TwoFactorStatus> => {
        const userId = request.caller!.id;
        const db = env.ctx.tenancy.db(request.tenant);
        // Plan ruling 6: nothing to offer without password sign-in.
        if (!env.settings.local || (await repo.credentialOf(db, userId)) === undefined) return { available: false };
        const methods = await twoFactorRepo.methodsOf(db, userId);
        return {
          available: true,
          enabled: twoFactorRepo.hasSecondFactor(methods),
          required: await twoFactorRequired(env.ctx, request.tenant),
          totp: methods.totp?.confirmedAt != null ? { addedAt: methods.totp.confirmedAt } : null,
          passkeys: methods.passkeys.map((passkey) => ({
            id: passkey.id,
            name: passkey.name,
            createdAt: passkey.createdAt,
            lastUsedAt: passkey.lastUsedAt,
          })),
          recoveryCodesLeft: methods.recoveryCodesLeft,
        };
      },
    );

    // Starts an authenticator (spec §5.1): a new secret, pending until its first code, answered once with its QR code.
    app.post(
      '/me/two-factor/totp',
      {
        schema: {
          body: jsonSchema(totpSetupRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(totpSetupResponseSchema) },
        },
      },
      async (request) => {
        const subject = await subjectOf(env, request, true);
        const db = env.ctx.tenancy.db(request.tenant);
        const credential = await credentialFor(env, db, subject.userId);
        await reauthenticate(env, request.tenant, subject, credential, (request.body as TotpSetupRequest).password);
        const user = await repo.findUserById(db, subject.userId);
        if (user === undefined) throw notFound('User');
        const secret = newTotpSecret();
        const sealed = sealTotpSecret(await env.ctx.tenancy.dataKey(request.tenant), user.id, secret);
        if (!(await twoFactorRepo.upsertPendingTotp(db, user.id, sealed, env.now()))) throw twoFactorExists();
        // Plan ruling 7: the server's host in the label, so two servers do not overwrite each other's entry.
        const host = new URL(primaryUrl(env.ctx.config, request)).host;
        const uri = otpauthUri({ secret, label: `Wirebench (${host}):${user.email}`, issuer: 'Wirebench' });
        return { uri, qrSvg: renderSVG(uri, { ecc: 'M', border: 2, pixelSize: 8 }), secret: base32(secret) };
      },
    );

    // Confirms the pending authenticator with its first code (spec §5.1). Under a setup challenge it also takes the
    // challenge and answers the session (spec §4.3).
    app.post(
      '/me/two-factor/totp/confirm',
      {
        schema: {
          body: jsonSchema(totpConfirmRequestSchema, { io: 'input' }),
          response: {
            200: jsonSchema(totpConfirmResponseSchema),
            201: jsonSchema(twoFactorSetupSignInResponseSchema),
          },
        },
      },
      async (request, reply) => {
        const subject = await subjectOf(env, request, true);
        const scope = request.tenant;
        const db = env.ctx.tenancy.db(scope);
        await credentialFor(env, db, subject.userId);
        // A setup challenge was charged as it was presented; a signed-in person is charged here.
        if (subject.kind === 'caller') await charge(env, scope, personKey(scope, subject.userId));
        const now = env.now();
        const pending = await twoFactorRepo.totpOf(db, subject.userId);
        if (
          pending === undefined ||
          pending.confirmedAt !== null ||
          new Date(pending.createdAt).getTime() + PENDING_TOTP_MS <= now.getTime()
        )
          throw twoFactorSetupExpired();
        const secret = openTotpSecret(await env.ctx.tenancy.dataKey(scope), subject.userId, pending.sealedSecret);
        const verdict = verifyTotp(secret, (request.body as TotpConfirmRequest).code, now.getTime(), -1);
        if (!verdict.ok) throw twoFactorInvalid();
        const source = auditSource(request);
        const event = selfEvent(source, subject);
        const answer = await db.transaction(async (tx) => {
          const wasOn = twoFactorRepo.hasSecondFactor(await twoFactorRepo.methodsOf(tx, subject.userId));
          if (!(await twoFactorRepo.confirmTotp(tx, subject.userId, verdict.step, now))) throw twoFactorSetupExpired();
          const recoveryCodes = await methodAdded(env, scope, tx, event, 'totp', wasOn);
          if (subject.kind === 'caller')
            return { status: 200 as const, body: recoveryCodes === undefined ? {} : { recoveryCodes } };
          if (!(await twoFactorRepo.takeChallenge(tx, subject.challenge.id))) throw twoFactorExpired();
          const user = await repo.findUserById(tx, subject.userId);
          if (user === undefined || user.disabledAt !== null) throw userDisabled();
          const session = await issueSession(env, tx, user, {
            method: 'local',
            deviceName: subject.challenge.deviceName ?? 'device',
            source,
            kind: subject.challenge.tokenKind ?? 'device',
            secondFactor: 'totp',
          });
          return { status: 201 as const, body: { ...session, recoveryCodes: recoveryCodes ?? [] } };
        });
        return reply.code(answer.status).send(answer.body);
      },
    );

    app.delete(
      '/me/two-factor/totp',
      { preHandler: requireUser, schema: { body: jsonSchema(reauthRequestSchema, { io: 'input' }) } },
      async (request, reply) => {
        const subject = await subjectOf(env, request);
        const scope = request.tenant;
        const db = env.ctx.tenancy.db(scope);
        const credential = await credentialFor(env, db, subject.userId);
        await reauthenticate(env, scope, subject, credential, (request.body as ReauthRequest).password);
        const event = selfEvent(auditSource(request), subject);
        await db.transaction(async (tx) => {
          const totp = await twoFactorRepo.totpOf(tx, subject.userId);
          // A pending secret is no method: nothing to remove.
          if (totp?.confirmedAt == null) throw notFound('Authenticator app');
          await twoFactorRepo.deleteTotp(tx, subject.userId);
          await methodRemoved(env, scope, tx, event, 'totp');
        });
        return reply.code(204).send();
      },
    );

    // New recovery codes (spec §5.3): the old set stops working.
    app.post(
      '/me/two-factor/recovery-codes',
      {
        preHandler: requireUser,
        schema: {
          body: jsonSchema(reauthRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(recoveryCodesResponseSchema) },
        },
      },
      async (request) => {
        const subject = await subjectOf(env, request);
        const scope = request.tenant;
        const db = env.ctx.tenancy.db(scope);
        const credential = await credentialFor(env, db, subject.userId);
        await reauthenticate(env, scope, subject, credential, (request.body as ReauthRequest).password);
        return db.transaction(async (tx) => {
          if (!twoFactorRepo.hasSecondFactor(await twoFactorRepo.methodsOf(tx, subject.userId))) throw twoFactorOff();
          const recoveryCodes = await issueRecoveryCodes(env, scope, tx, subject.userId);
          await recordAudit(env.ctx.hooks, tx, {
            ...selfEvent(auditSource(request), subject),
            action: 'user.recovery_codes_regenerated',
          });
          return { recoveryCodes };
        });
      },
    );

    // Passkeys (spec §5.2): the creation options after the password, then the browser's answer with a name.
    app.post(
      '/me/two-factor/passkeys/options',
      {
        preHandler: requireUser,
        schema: {
          body: jsonSchema(reauthRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(webauthnJsonSchema) },
        },
      },
      async (request) => {
        const subject = await subjectOf(env, request);
        const scope = request.tenant;
        const db = env.ctx.tenancy.db(scope);
        const credential = await credentialFor(env, db, subject.userId);
        await reauthenticate(env, scope, subject, credential, (request.body as ReauthRequest).password);
        if ((await twoFactorRepo.passkeysOf(db, subject.userId)).length >= MAX_PASSKEYS)
          throw passkeyLimit(MAX_PASSKEYS);
        const user = await repo.findUserById(db, subject.userId);
        if (user === undefined) throw notFound('User');
        return registrationOptions(env, scope, request, user);
      },
    );

    app.post(
      '/me/two-factor/passkeys',
      {
        preHandler: requireUser,
        schema: {
          body: jsonSchema(passkeyAddRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(passkeyAddResponseSchema) },
        },
      },
      async (request, reply) => {
        const subject = await subjectOf(env, request);
        const scope = request.tenant;
        const db = env.ctx.tenancy.db(scope);
        await credentialFor(env, db, subject.userId);
        const body = request.body as PasskeyAddRequest;
        // The options took the password moments ago; this answer is bound to them by their WebAuthn challenge.
        const verified = await verifyNewPasskey(env, scope, request, subject.userId, body.response);
        const id = newId();
        const at = env.now();
        const event = selfEvent(auditSource(request), subject);
        const recoveryCodes = await db.transaction(async (tx) => {
          const methods = await twoFactorRepo.methodsOf(tx, subject.userId);
          if (methods.passkeys.length >= MAX_PASSKEYS) throw passkeyLimit(MAX_PASSKEYS);
          if (methods.passkeys.some((passkey) => passkey.credentialId.equals(verified.credentialId)))
            throw passkeyFailed();
          await twoFactorRepo.insertPasskey(tx, {
            id,
            userId: subject.userId,
            ...verified,
            name: body.name.trim() || 'Passkey',
            at,
          });
          return methodAdded(env, scope, tx, event, 'passkey', twoFactorRepo.hasSecondFactor(methods), id);
        });
        return reply.code(201).send({
          passkey: { id, name: body.name.trim() || 'Passkey', createdAt: at.toISOString(), lastUsedAt: null },
          ...(recoveryCodes !== undefined ? { recoveryCodes } : {}),
        });
      },
    );

    // A new name needs no password: it changes nothing about how anyone signs in.
    app.patch(
      '/me/two-factor/passkeys/:id',
      {
        preHandler: requireUser,
        schema: {
          params: jsonSchema(identityIdParamsSchema, { io: 'input' }),
          body: jsonSchema(passkeyRenameRequestSchema, { io: 'input' }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const name = (request.body as PasskeyRenameRequest).name.trim();
        if (name === '') throw displayNameInvalid();
        const db = env.ctx.tenancy.db(request.tenant);
        if (!(await twoFactorRepo.renamePasskey(db, request.caller!.id, id, name))) throw notFound('Passkey');
        return reply.code(204).send();
      },
    );

    app.delete(
      '/me/two-factor/passkeys/:id',
      {
        preHandler: requireUser,
        schema: {
          params: jsonSchema(identityIdParamsSchema, { io: 'input' }),
          body: jsonSchema(reauthRequestSchema, { io: 'input' }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const subject = await subjectOf(env, request);
        const scope = request.tenant;
        const db = env.ctx.tenancy.db(scope);
        const credential = await credentialFor(env, db, subject.userId);
        await reauthenticate(env, scope, subject, credential, (request.body as ReauthRequest).password);
        const event = selfEvent(auditSource(request), subject);
        await db.transaction(async (tx) => {
          if (!(await twoFactorRepo.deletePasskey(tx, subject.userId, id))) throw notFound('Passkey');
          await methodRemoved(env, scope, tx, event, 'passkey', id);
        });
        return reply.code(204).send();
      },
    );
  };
