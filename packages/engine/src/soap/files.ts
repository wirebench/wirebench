/**
 * The SOAP files of a project folder: `interfaces/<slug>/interface.yaml` and each
 * `operations/<slug>/<name>.request.yaml` under it (spec §3.2). The shared pieces and the
 * strictness policy are `project/schema-parts.ts`'s.
 */

import { z } from 'zod';
import { assertionsSchema } from '../assert/schema.js';
import { attachmentSourceSchema, nonEmpty, scriptsSchema, soapOwnerAuthSchema } from '../project/schema-parts.js';

const endpointSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  url: z.string(),
  auth: soapOwnerAuthSchema.optional(),
  authMode: z.enum(['override', 'complement']),
  trustInvalid: z.boolean().optional(),
});

/**
 * A stored WS-Addressing configuration. Every field beyond `enabled` is optional so a project
 * written before the WS-Addressing task — which only ever held `{ enabled, version? }` — still
 * loads; `normalizeWsa` fills the rest in with the v1 defaults.
 */
const wsaSchema = z.looseObject({
  enabled: z.boolean(),
  version: z.enum(['2005/08', '2004/08']).optional(),
  mustUnderstand: z.enum(['none', 'true', 'false']).optional(),
  action: z.string().optional(),
  to: z.string().optional(),
  messageId: z.string().optional(),
  replyTo: z.string().optional(),
  from: z.string().optional(),
  faultTo: z.string().optional(),
  relatesTo: z.string().optional(),
  relationshipType: z.string().optional(),
  addDefaultAction: z.boolean().optional(),
  addDefaultTo: z.boolean().optional(),
  generateMessageId: z.boolean().optional(),
});

const operationEntrySchema = z.looseObject({
  name: nonEmpty,
  bindingName: z.string(),
  slug: nonEmpty,
  order: z.number().int(),
});

/** `interfaces/<slug>/interface.yaml`. */
export const interfaceFileSchema = z.looseObject({
  kind: z.literal('soap'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  definitionUrl: z.string(),
  cacheDefinition: z.boolean(),
  targetNamespace: z.string().optional(),
  endpoints: z.array(endpointSchema),
  defaultEndpointId: z.string().optional(),
  wsa: wsaSchema,
  auth: soapOwnerAuthSchema.optional(),
  operations: z.array(operationEntrySchema),
});

const requestPropertiesSchema = z.looseObject({
  encoding: z.string(),
  timeoutMs: z.number().int().nonnegative().optional(),
  bindAddress: z.string().optional(),
  followRedirects: z.boolean(),
  skipSoapAction: z.boolean(),
  enableMtom: z.boolean(),
  forceMtom: z.boolean(),
  inlineResponseAttachments: z.boolean(),
  expandMtomAttachments: z.boolean(),
  disableMultiparts: z.boolean(),
  encodeAttachments: z.boolean(),
  enableInlineFiles: z.boolean(),
  removeEmptyContent: z.boolean(),
  entitizeProperties: z.boolean(),
  prettyPrint: z.boolean(),
  stripWhitespaces: z.boolean(),
  dumpFile: z.string().optional(),
  maxSizeBytes: z.number().int().nonnegative().optional(),
  wssPasswordType: z.enum(['text', 'digest']).optional(),
  wssTimeToLive: z.number().int().nonnegative().optional(),
  sslKeystoreRef: z.string().optional(),
});

const attachmentSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  part: z.string().optional(),
  type: z.enum(['XOP', 'MIME', 'SWAREF', 'CONTENT', 'UNKNOWN']),
  contentId: z.string(),
  cached: z.boolean(),
  source: attachmentSourceSchema,
});

/** `interfaces/<slug>/operations/<slug>/<name>.request.yaml` (the envelope lives in the sibling `.xml`). */
export const requestFileSchema = z.looseObject({
  kind: z.literal('soap'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  endpointId: z.string().optional(),
  endpointUrl: z.string().optional(),
  soapVersion: z.enum(['1.1', '1.2']),
  soapAction: z.string().optional(),
  headers: z.array(
    z.looseObject({
      name: z.string(),
      value: z.string(),
      enabled: z.boolean().optional(),
      description: z.string().optional(),
    }),
  ),
  attachments: z.array(attachmentSchema),
  auth: soapOwnerAuthSchema.optional(),
  wsa: wsaSchema.optional(),
  wssOutgoingRef: z.string().optional(),
  wssIncomingRef: z.string().optional(),
  properties: requestPropertiesSchema,
  assertions: assertionsSchema.default([]),
  orphaned: z.boolean().optional(),
  scripts: scriptsSchema.optional(),
});

/** An interface document as persisted. */
export type InterfaceFile = z.infer<typeof interfaceFileSchema>;
/** A request document as persisted (envelope excluded). */
export type RequestFile = z.infer<typeof requestFileSchema>;
