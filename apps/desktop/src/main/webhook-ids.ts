/**
 * The synthetic id a project's webhook collection travels under on the wire: `webhooks:<projectId>`,
 * never a real API id. Its own tiny module so `project-wire.ts` (which only ever reads a `Project`)
 * does not have to import anything from `project-webhook-mutations.ts` (which writes one).
 */

import { WEBHOOKS_COLLECTION_PREFIX } from '@wirebench/engine';

/** The wire id of a project's webhook collection. */
export function webhookCollectionId(projectId: string): string {
  return `${WEBHOOKS_COLLECTION_PREFIX}${projectId}`;
}

/** Whether `id` names a project's webhook collection rather than an API. */
export function isWebhookCollectionId(id: string): boolean {
  return id.startsWith(WEBHOOKS_COLLECTION_PREFIX);
}
