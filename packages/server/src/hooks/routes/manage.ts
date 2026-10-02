/**
 * The management API (webhook-capture spec §3.5), under `/api/v1`, guarded by teams-access's
 * `requireWorkspaceRole`: viewers read, editors and admins change. Identity's `onRequest` hook has set
 * `request.caller` before the guard runs, because this module registers after identity in the shared
 * scope. Every change announces `hooksChanged` after it has committed (§3.6).
 */
import {
  CATCH_URL_DEFAULT_RESPONSE,
  CATCH_URL_PATH_PREFIX,
  captureParamsSchema,
  captureSchema,
  capturesQuerySchema,
  capturesResponseSchema,
  catchUrlCreateRequestSchema,
  catchUrlParamsSchema,
  catchUrlSchema,
  catchUrlUpdateRequestSchema,
  HOOKS_LIMITS,
  signatureSchemeSchema,
  teamWorkspaceParamsSchema,
  toSignatureScheme,
  type Capture,
  type CaptureSummary,
  type CapturesQuery,
  type CatchUrl,
  type CatchUrlCreateRequest,
  type CatchUrlUpdateRequest,
} from '@wirebench/engine';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { announce, auditSource, recordAudit } from '../../context.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../db/errors.js';
import { newId } from '../../identity/tokens.js';
import { jsonSchema } from '../../schema.js';
import { workspaceNotFound } from '../../teams/errors.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import type { HooksEnv } from '../env.js';
import {
  captureNotFound,
  catchUrlLimitReached,
  catchUrlNameInvalid,
  catchUrlNameTaken,
  catchUrlNotFound,
  cursorConflict,
  rejectNeedsSignature,
  responseBodyTooLarge,
  signatureKeyUnset,
  signatureSecretRequired,
} from '../errors.js';
import * as repo from '../repo.js';
import { mintCatchSecret } from '../secret.js';
import { hintOf, seal } from '../secret-box.js';

/** Who is reading, for what a row shows (§3.4): the hint only to editors, and whether signatures work. */
export interface CatchUrlView {
  readonly showHint: boolean;
  readonly signatureAvailable: boolean;
}

/**
 * The list's response schema, server side only: `url` may be missing, for a CI principal. The
 * engine's `catchUrlSchema` keeps it required, so every other reader still gets it.
 */
const catchUrlsListedSchema = z.array(catchUrlSchema.extend({ url: catchUrlSchema.shape.url.optional() }));
type ListedCatchUrl = CatchUrl | Omit<CatchUrl, 'url'>;

function withoutUrl(hook: CatchUrl): Omit<CatchUrl, 'url'> {
  const { url, ...rest } = hook;
  void url; // dropped on purpose: it holds the catch secret
  return rest;
}

/** A row as the wire shows it: the secret only inside the full URL (§5); the signature secret never. */
export function toCatchUrl(row: repo.CatchUrlListRow, publicUrl: string, view: CatchUrlView): CatchUrl {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    url: `${publicUrl}${CATCH_URL_PATH_PREFIX}${row.secret}`,
    enabled: row.enabled,
    response: row.response,
    captureCount: row.captureCount,
    newestCaptureId: row.newestCaptureId,
    createdAt: row.createdAt,
    signature:
      row.signature === null
        ? null
        : { scheme: row.signature, secret: { set: true, hint: view.showHint ? row.signatureHint : null } },
    rejectUnverified: row.rejectUnverified,
    signatureAvailable: view.signatureAvailable,
  };
}

/** §3.5: 1–100 characters after trimming; JSON Schema cannot trim, so the handler re-checks. */
function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > HOOKS_LIMITS.maxNameLength) throw catchUrlNameInvalid();
  return name;
}

/** §3.5: the body limit is in UTF-8 bytes; the schema's `max` only bounded characters. */
function checkResponse(response: repo.ResponsePatch | undefined): void {
  const body = response?.body;
  if (typeof body === 'string' && Buffer.byteLength(body, 'utf8') > HOOKS_LIMITS.maxResponseBodyBytes) {
    throw responseBodyTooLarge();
  }
}

/**
 * What a `PATCH`'s `signature` and `rejectUnverified` do to the row (§3.4): `undefined` leaves the
 * signature alone, `null` clears it, a patch sets it. The scheme is re-parsed with zod: Ajv applies
 * no defaults inside a union, and the stored scheme must be exactly what the engine reads back.
 *
 * @throws problems `hooks-signature-key-unset`, `hooks-signature-secret-required`, `invalid-request`
 */
export function signaturePatchOf(
  body: Pick<CatchUrlUpdateRequest, 'signature' | 'rejectUnverified'>,
  current: Pick<repo.CatchUrlRow, 'signature' | 'secretSet'>,
  key: Buffer | undefined,
): repo.SignaturePatch | null | undefined {
  if (body.signature === null) {
    if (body.rejectUnverified === true) throw rejectNeedsSignature();
    return null;
  }
  if (body.signature === undefined) {
    if (body.rejectUnverified === true && current.signature === null) throw rejectNeedsSignature();
    return undefined;
  }
  if (key === undefined) throw signatureKeyUnset();
  const scheme = toSignatureScheme(signatureSchemeSchema.parse(body.signature.scheme));
  const secret = body.signature.secret;
  if (secret === undefined) {
    if (!current.secretSet) throw signatureSecretRequired();
    return { scheme };
  }
  return { scheme, sealedSecret: seal(key, secret), hint: hintOf(secret) };
}

/** A racing duplicate answers like the name rule; a racing workspace delete like the guard. */
function conflictOr(error: unknown): never {
  if (isUniqueViolation(error, repo.CATCH_URL_NAME_INDEX)) throw catchUrlNameTaken();
  if (isForeignKeyViolation(error, repo.CATCH_URL_WORKSPACE_FK)) throw workspaceNotFound();
  throw error;
}

export const manageRoutes =
  (env: HooksEnv) =>
  (app: FastifyInstance): void => {
    const { db, config } = env.ctx;
    const one = jsonSchema(catchUrlSchema);
    const listed = jsonSchema(catchUrlsListedSchema);
    const workspaceParams = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });
    const hookParams = jsonSchema(catchUrlParamsSchema, { io: 'input' });

    const found = async (workspaceId: string, hookId: string): Promise<repo.CatchUrlListRow> => {
      const row = await repo.catchUrlInWorkspace(db, workspaceId, hookId);
      if (row === undefined) throw catchUrlNotFound();
      return row;
    };
    const hookOf = (request: FastifyRequest): { readonly workspaceId: string; readonly hookId: string } => ({
      workspaceId: request.workspaceAccess!.workspaceId,
      hookId: (request.params as { readonly hookId: string }).hookId,
    });

    const viewOf = (request: FastifyRequest): CatchUrlView => ({
      showHint: request.workspaceAccess!.role !== 'viewer',
      signatureAvailable: env.settings.secretKey !== undefined,
    });

    app.get(
      '/workspaces/:workspaceId/hooks',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: { params: workspaceParams, response: { 200: listed } },
      },
      async (request): Promise<ListedCatchUrl[]> => {
        const rows = await repo.catchUrlsOfWorkspace(db, request.workspaceAccess!.workspaceId);
        const hooks = rows.map((row) => toCatchUrl(row, config.publicUrl, viewOf(request)));
        // A CI token never sees the catch secret: a leaked one could forge the captures it reads
        // (callback-assertion §3). It needs a hook's id and name only.
        return request.ciCaller === undefined ? hooks : hooks.map(withoutUrl);
      },
    );

    app.post(
      '/workspaces/:workspaceId/hooks',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: {
          params: workspaceParams,
          body: jsonSchema(catchUrlCreateRequestSchema, { io: 'input' }),
          response: { 201: one },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const body = request.body as CatchUrlCreateRequest;
        const name = cleanName(body.name);
        checkResponse(body.response);
        const id = newId();
        const source = auditSource(request);
        try {
          await db.transaction(async (tx) => {
            if (!(await repo.lockWorkspace(tx, workspaceId))) throw workspaceNotFound();
            if ((await repo.countCatchUrls(tx, workspaceId)) >= env.settings.perWorkspace) {
              throw catchUrlLimitReached(env.settings.perWorkspace);
            }
            await repo.insertCatchUrl(tx, {
              id,
              workspaceId,
              name,
              secret: mintCatchSecret(),
              enabled: body.enabled ?? true,
              response: {
                status: body.response?.status ?? CATCH_URL_DEFAULT_RESPONSE.status,
                contentType: body.response?.contentType ?? CATCH_URL_DEFAULT_RESPONSE.contentType,
                body: body.response?.body ?? CATCH_URL_DEFAULT_RESPONSE.body,
                delayMs: body.response?.delayMs ?? CATCH_URL_DEFAULT_RESPONSE.delayMs,
              },
              createdBy: request.caller!.id,
              at: env.now(),
            });
            await recordAudit(env.ctx.hooks, tx, {
              ...source,
              action: 'hook.created',
              target: { kind: 'hook', id },
              workspaceId,
              details: { name },
            });
          });
        } catch (error) {
          conflictOr(error);
        }
        announce(env.ctx.hooks.hooksChanged, { workspaceId }, request.log);
        return reply.code(201).send(toCatchUrl(await found(workspaceId, id), config.publicUrl, viewOf(request)));
      },
    );

    app.patch(
      '/workspaces/:workspaceId/hooks/:hookId',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: {
          params: hookParams,
          body: jsonSchema(catchUrlUpdateRequestSchema, { io: 'input' }),
          response: { 200: one },
        },
      },
      async (request): Promise<CatchUrl> => {
        const { workspaceId, hookId } = hookOf(request);
        const body = request.body as CatchUrlUpdateRequest;
        const current = await found(workspaceId, hookId);
        checkResponse(body.response);
        const signature = signaturePatchOf(body, current, env.settings.secretKey);
        const name = body.name !== undefined ? cleanName(body.name) : undefined;
        const source = auditSource(request);
        const target = { kind: 'hook', id: hookId } as const;
        let updated: boolean;
        try {
          updated = await db.transaction(async (tx) => {
            const done = await repo.updateCatchUrl(tx, hookId, {
              ...(name !== undefined ? { name } : {}),
              ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
              ...(body.response !== undefined ? { response: body.response } : {}),
              ...(signature !== undefined ? { signature } : {}),
              ...(body.rejectUnverified !== undefined ? { rejectUnverified: body.rejectUnverified } : {}),
            });
            if (!done) return false;
            // hook.changed is for what the signature events do not say: a name, the switch, the reject flag.
            const changed: Record<string, string | boolean> = {};
            if (name !== undefined && name !== current.name) {
              changed['name'] = name;
              changed['previousName'] = current.name;
            }
            if (body.enabled !== undefined && body.enabled !== current.enabled) changed['enabled'] = body.enabled;
            if (body.rejectUnverified !== undefined && body.rejectUnverified !== current.rejectUnverified) {
              changed['rejectUnverified'] = body.rejectUnverified;
            }
            if (Object.keys(changed).length > 0) {
              await recordAudit(env.ctx.hooks, tx, {
                ...source,
                action: 'hook.changed',
                target,
                workspaceId,
                details: changed,
              });
            }
            if (signature === null) {
              await recordAudit(env.ctx.hooks, tx, {
                ...source,
                action: 'hook.signature_cleared',
                target,
                workspaceId,
                details: { scheme: current.signature?.kind ?? null },
              });
            } else if (signature !== undefined) {
              await recordAudit(env.ctx.hooks, tx, {
                ...source,
                action: 'hook.signature_set',
                target,
                workspaceId,
                details: { scheme: signature.scheme.kind },
              });
            }
            return true;
          });
        } catch (error) {
          conflictOr(error);
        }
        if (!updated) throw catchUrlNotFound();
        announce(env.ctx.hooks.hooksChanged, { workspaceId }, request.log);
        return toCatchUrl(await found(workspaceId, hookId), config.publicUrl, viewOf(request));
      },
    );

    app.post(
      '/workspaces/:workspaceId/hooks/:hookId/rotate',
      { preHandler: requireWorkspaceRole(db, 'editor'), schema: { params: hookParams, response: { 200: one } } },
      async (request): Promise<CatchUrl> => {
        const { workspaceId, hookId } = hookOf(request);
        const row = await found(workspaceId, hookId);
        const source = auditSource(request);
        // The old URL answers 404 from the moment this commits (§3.5).
        await db.transaction(async (tx) => {
          if (!(await repo.rotateSecret(tx, hookId, mintCatchSecret()))) throw catchUrlNotFound();
          await recordAudit(env.ctx.hooks, tx, {
            ...source,
            action: 'hook.rotated',
            target: { kind: 'hook', id: hookId },
            workspaceId,
            details: { name: row.name },
          });
        });
        announce(env.ctx.hooks.hooksChanged, { workspaceId }, request.log);
        return toCatchUrl(await found(workspaceId, hookId), config.publicUrl, viewOf(request));
      },
    );

    app.delete(
      '/workspaces/:workspaceId/hooks/:hookId',
      { preHandler: requireWorkspaceRole(db, 'editor'), schema: { params: hookParams } },
      async (request, reply) => {
        const { workspaceId, hookId } = hookOf(request);
        const row = await found(workspaceId, hookId);
        const source = auditSource(request);
        await db.transaction(async (tx) => {
          if (!(await repo.deleteCatchUrl(tx, hookId))) throw catchUrlNotFound();
          await recordAudit(env.ctx.hooks, tx, {
            ...source,
            action: 'hook.deleted',
            target: { kind: 'hook', id: hookId },
            workspaceId,
            details: { name: row.name },
          });
        });
        announce(env.ctx.hooks.hooksChanged, { workspaceId }, request.log);
        return reply.code(204).send();
      },
    );

    app.get(
      '/workspaces/:workspaceId/hooks/:hookId/captures',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: hookParams,
          querystring: jsonSchema(capturesQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(capturesResponseSchema) },
        },
      },
      async (request): Promise<CaptureSummary[]> => {
        const { workspaceId, hookId } = hookOf(request);
        const query = request.query as CapturesQuery;
        if (query.before !== undefined && query.after !== undefined) throw cursorConflict();
        await found(workspaceId, hookId);
        const page: repo.CapturePage =
          query.after !== undefined
            ? { after: query.after }
            : query.before !== undefined
              ? { before: query.before }
              : {};
        return repo.listCaptures(db, hookId, page, query.limit ?? HOOKS_LIMITS.defaultPageSize);
      },
    );

    app.get(
      '/workspaces/:workspaceId/hooks/:hookId/captures/:captureId',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(captureParamsSchema, { io: 'input' }),
          response: { 200: jsonSchema(captureSchema) },
        },
      },
      async (request): Promise<Capture> => {
        const { workspaceId, hookId } = hookOf(request);
        const { captureId } = request.params as { readonly captureId: string };
        await found(workspaceId, hookId);
        const row = await repo.captureById(db, hookId, captureId);
        if (row === undefined) throw captureNotFound();
        return { ...row, body: row.body.toString('base64') };
      },
    );

    app.delete(
      '/workspaces/:workspaceId/hooks/:hookId/captures',
      { preHandler: requireWorkspaceRole(db, 'editor'), schema: { params: hookParams } },
      async (request, reply) => {
        const { workspaceId, hookId } = hookOf(request);
        const row = await found(workspaceId, hookId);
        const source = auditSource(request);
        await db.transaction(async (tx) => {
          const removed = await repo.clearCaptures(tx, hookId);
          await recordAudit(env.ctx.hooks, tx, {
            ...source,
            action: 'hook.cleared',
            target: { kind: 'hook', id: hookId },
            workspaceId,
            details: { name: row.name, captures: removed },
          });
        });
        announce(env.ctx.hooks.hooksChanged, { workspaceId }, request.log);
        return reply.code(204).send();
      },
    );
  };
