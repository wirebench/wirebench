/**
 * The webhook collection's own files (spec §3): `webhooks/webhooks.yaml` and a folder of its request
 * tree. Its requests are REST requests, read with `rest/files.ts`'s schema.
 */
import { z } from 'zod';
import { authConfigSchema, nonEmpty, restFolderFileSchema, webhookSigningSchema } from '#core/project/schema-parts';

/** `webhooks/webhooks.yaml`. */
export const webhooksFileSchema = z.looseObject({
  target: z.string(),
  auth: authConfigSchema.optional(),
  signing: webhookSigningSchema.optional(),
});

/** `webhooks/requests/[<folder>/…]folder.yaml`: a REST folder plus a target override and its source API. */
export const webhookFolderFileSchema = restFolderFileSchema.extend({
  target: z.string().optional(),
  source: z.looseObject({ apiId: nonEmpty }).optional(),
  signing: webhookSigningSchema.optional(),
});
