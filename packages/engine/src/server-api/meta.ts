/**
 * What `GET /api/v1/meta` answers (host spec §3.2). Shared with the desktop so the Sign in
 * dialog can tell a Wirebench Server from any other host by shape, not by guesswork.
 */
import { z } from 'zod';

export const SERVER_NAME = 'wirebench-server';
export const SERVER_API_VERSION = 1;

export const metaResponseSchema = z.object({
  name: z.literal(SERVER_NAME),
  version: z.string(),
  apiVersion: z.literal(SERVER_API_VERSION),
  publicUrl: z.string().url(),
  auth: z.object({ local: z.boolean(), oidc: z.boolean(), oidcDisplayName: z.string().optional() }),
  capabilities: z.array(z.string()),
});
export type MetaResponse = z.infer<typeof metaResponseSchema>;
