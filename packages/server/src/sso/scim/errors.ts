/**
 * The SCIM error shape (RFC 7644 §3.12, plan ruling 5). The host's `{ code, message }` problems do not fit
 * it, so the SCIM scope maps every error through {@link toScimError} and nothing under `/scim/v2` ever
 * answers in the `/api/v1` shape.
 */
import { isWirebenchError } from '@wirebench/engine';

export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

export type ScimType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue';

export interface ScimErrorBody {
  readonly schemas: readonly [typeof SCIM_ERROR_SCHEMA];
  readonly status: string;
  readonly scimType?: ScimType;
  readonly detail: string;
}

export class ScimError extends Error {
  override readonly name = 'ScimError';
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimType,
  ) {
    super(detail);
  }

  body(): ScimErrorBody {
    return {
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(this.status),
      ...(this.scimType !== undefined ? { scimType: this.scimType } : {}),
      detail: this.detail,
    };
  }
}

export const scimError = (status: number, detail: string, scimType?: ScimType): ScimError =>
  new ScimError(status, detail, scimType);

/** Any error thrown in the SCIM scope, as a SCIM error. Internal failures say nothing about themselves. */
export function toScimError(error: unknown): ScimError {
  if (error instanceof ScimError) return error;
  const fastify = error as { readonly code?: string; readonly statusCode?: number; readonly validation?: unknown };
  if (fastify.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return scimError(413, 'The request body is too large.');
  if (fastify.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
    return scimError(415, 'Send application/scim+json or application/json.');
  if (fastify.validation !== undefined || fastify.code === 'FST_ERR_CTP_INVALID_JSON_BODY')
    return scimError(400, 'The request is not valid JSON of the expected shape.', 'invalidSyntax');
  if (isWirebenchError(error)) {
    if (error.code === 'licensing-seat-limit') return scimError(403, error.message);
    if (error.code === 'licensing-feature-required') return scimError(403, error.message);
  }
  const status = fastify.statusCode;
  if (status !== undefined && status >= 400 && status < 500) return scimError(status, 'The request was refused.');
  return scimError(500, 'The server could not complete the request.');
}
