/**
 * Profile images and profile cards (user profile spec §6.2, §9). A person changes only their own images; anyone
 * signed in on the same server reads an image, and a profile is read by the person, their team mates and server
 * admins. Everyone else gets 404, so the routes do not confirm who exists.
 */
import { createHash } from 'node:crypto';
import {
  IMAGE_LIMITS,
  imageParamsSchema,
  imageRefSchema,
  imageUploadRequestSchema,
  userImageParamsSchema,
  userProfileSchema,
  type ImageKind,
  type ImageUploadRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { auditSource, recordAudit } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { imageInvalid, imageTooLarge, notFound, unauthenticated } from '../errors.js';
import { requireUser } from '../guard.js';
import { profileLimit } from '../profile-limit.js';
import * as repo from '../repo.js';
import { imageRef } from '../sessions.js';
import { checkWebp, decodeBase64Strict } from '../webp.js';

/** Spec §6.2: the cover's 2 MB as base64, with room for the JSON around it. */
export const IMAGE_BODY_LIMIT = 3 * 1024 * 1024;
const WEBP = 'image/webp';

/** The bytes of an upload, checked as spec §9 asks: strict base64, the cap, then the WebP header and its size. */
export function checkUpload(kind: ImageKind, data: string): Buffer {
  const limits = IMAGE_LIMITS[kind];
  // A base64 string longer than the cap's encoding is too large before it is decoded.
  if (data.length > Math.ceil(limits.maxBytes / 3) * 4) throw imageTooLarge(kind);
  const bytes = decodeBase64Strict(data);
  if (bytes === undefined) throw imageInvalid('The image is not valid base64.');
  if (bytes.length > limits.maxBytes) throw imageTooLarge(kind);
  const checked = checkWebp(bytes);
  if (!checked.ok) throw imageInvalid(`The image is not a plain WebP file: ${checked.reason}.`);
  if (checked.width !== limits.width || checked.height !== limits.height) {
    throw imageInvalid(`A ${kind} must be ${String(limits.width)} × ${String(limits.height)} pixels.`);
  }
  return bytes;
}

export const profileRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.put(
      '/me/images/:kind',
      {
        bodyLimit: IMAGE_BODY_LIMIT,
        preHandler: [requireUser, profileLimit(env, 'uploads')],
        schema: {
          params: jsonSchema(imageParamsSchema, { io: 'input' }),
          body: jsonSchema(imageUploadRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(imageRefSchema) },
        },
      },
      async (request) => {
        const caller = request.caller!;
        const { kind } = request.params as { kind: ImageKind };
        const body = request.body as ImageUploadRequest;
        const bytes = checkUpload(kind, body.data);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
          if ((await repo.findUserById(tx, caller.id)) === undefined) throw unauthenticated();
          // Stored as the type it was checked to be, never as anything the request says.
          await repo.putImage(tx, { userId: caller.id, kind, contentType: WEBP, data: bytes, sha256, at: env.now() });
          await recordAudit(env.ctx.hooks, tx, {
            ...auditSource(request),
            action: 'user.updated',
            target: { kind: 'user', id: caller.id },
            details: { fields: [kind], via: 'self' },
          });
        });
        return { version: sha256.slice(0, 16) };
      },
    );

    app.delete(
      '/me/images/:kind',
      {
        preHandler: [requireUser, profileLimit(env, 'changes')],
        schema: { params: jsonSchema(imageParamsSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const caller = request.caller!;
        const { kind } = request.params as { kind: ImageKind };
        await env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
          // Removing what is not there changes nothing, and records nothing.
          if (!(await repo.deleteImage(tx, caller.id, kind))) return;
          await recordAudit(env.ctx.hooks, tx, {
            ...auditSource(request),
            action: 'user.updated',
            target: { kind: 'user', id: caller.id },
            details: { fields: [kind], via: 'self' },
          });
        });
        return reply.code(204).send();
      },
    );

    app.get(
      '/users/:id/images/:kind',
      { preHandler: requireUser, schema: { params: jsonSchema(userImageParamsSchema, { io: 'input' }) } },
      async (request, reply) => {
        const { id, kind } = request.params as { id: string; kind: ImageKind };
        // Row-level security keeps another tenant's images out of reach in the database too.
        const image = await repo.getImage(env.ctx.tenancy.db(request.tenant), id, kind);
        if (image === undefined) throw notFound('Image');
        const etag = `"${image.sha256}"`;
        void reply
          .header('content-type', image.contentType)
          .header('x-content-type-options', 'nosniff')
          .header('content-disposition', `inline; filename="${kind}.webp"`)
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('cache-control', 'private, max-age=86400')
          .header('etag', etag);
        if (request.headers['if-none-match'] === etag) return reply.code(304).send();
        return reply.code(200).send(image.data);
      },
    );

    app.get(
      '/users/:id/profile',
      {
        preHandler: requireUser,
        schema: {
          params: jsonSchema(userImageParamsSchema.pick({ id: true }), { io: 'input' }),
          response: { 200: jsonSchema(userProfileSchema) },
        },
      },
      async (request) => {
        const caller = request.caller!;
        const { id } = request.params as { id: string };
        return env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
          // Ruling 3: the person, a server admin, or someone on one of their teams; anyone else learns nothing.
          const allowed = caller.id === id || caller.serverAdmin || (await repo.sharesTeam(tx, caller.id, id));
          const user = allowed ? await repo.findUserById(tx, id) : undefined;
          if (user === undefined) throw notFound('Person');
          return {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
            username: user.username,
            about: user.about,
            photo: imageRef(user.photo),
            cover: imageRef(user.cover),
          };
        });
      },
    );
  };
