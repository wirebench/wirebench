import { z } from 'zod';
import { GRPC_STATUS_NAMES } from '../grpc/status.js';
import { CALLBACK_LIMITS } from './model.js';
import type { CallbackAssertion, CallbackBodyCheck, CallbackCheck, CallbackHeaderCheck } from './model.js';

const name = z.string().min(1).optional();
const grpcStatusNames = Object.values(GRPC_STATUS_NAMES) as [string, ...string[]];
const statusValue = z.union([
  z.number().int().min(100).max(599),
  z.number().int().min(0).max(16),
  z.string().regex(/^[1-5]xx$/),
  z.enum(grpcStatusNames),
]);

const statusSchema = z.looseObject({
  type: z.literal('status'),
  equals: z.union([statusValue, z.array(statusValue).min(1)]),
  name,
});

const soapFaultSchema = z.looseObject({
  type: z.literal('soap-fault'),
  expect: z.enum(['none', 'present']).default('none'),
  name,
});

const matchSchema = z.looseObject({
  type: z.literal('match'),
  language: z.enum(['xpath', 'xquery', 'jsonpath']),
  expression: z.string().min(1),
  namespaces: z.record(z.string(), z.string()).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
  name,
});

const schemaSchema = z.looseObject({ type: z.literal('schema'), name });
const slaSchema = z.looseObject({ type: z.literal('sla'), maxMs: z.number().int().positive(), name });

const headerSchema = z.looseObject({
  type: z.literal('header'),
  header: z.string().min(1),
  equals: z.string().optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
  name,
});

function compiles(pattern: string, path: readonly string[], ctx: z.RefinementCtx): void {
  try {
    // Compiling is linear in the pattern's length; only matching can run away, and that happens on
    // the evaluation worker (`matchRegexWithTimeout`).
    new RegExp(pattern);
  } catch {
    ctx.addIssue({ code: 'custom', path: [...path], message: 'not a valid regular expression' });
  }
}

/** Exactly one of `equals`, `matches` or `exists`, and a `matches:` that compiles. */
function refineOneCheck(
  value: {
    readonly equals?: unknown;
    readonly matches?: string | undefined;
    readonly exists?: boolean | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const given = [value.equals, value.matches, value.exists].filter((v) => v !== undefined).length;
  if (given !== 1) {
    ctx.addIssue({ code: 'custom', message: 'exactly one of equals, matches or exists is required' });
  }
  if (value.matches !== undefined) {
    compiles(value.matches, ['matches'], ctx);
  }
}

/** A `match` or `header` assertion names exactly one check, and a `matches:` must compile. */
function refineCheck(
  value: {
    readonly type: string;
    readonly equals?: unknown;
    readonly matches?: string | undefined;
    readonly exists?: boolean | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.type === 'match' || value.type === 'header') {
    refineOneCheck(value, ctx);
  }
}

const oneCheck = {
  equals: z.string().optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
};

const callbackHeaderSchema = z.looseObject({ name: z.string().min(1), ...oneCheck }).superRefine(refineOneCheck);
const callbackBodySchema = z
  .looseObject({ language: z.enum(['jsonpath', 'xpath']), path: z.string().min(1), ...oneCheck })
  .superRefine(refineOneCheck);

const callbackMatchSchema = z
  .looseObject({
    method: z.string().min(1).optional(),
    path: z.string().startsWith('/').optional(),
    pathMatches: z.string().min(1).optional(),
    headers: z.array(callbackHeaderSchema).max(CALLBACK_LIMITS.maxHeaderChecks).optional(),
    body: callbackBodySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.path !== undefined && value.pathMatches !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'at most one of path and pathMatches' });
    }
    if (value.pathMatches !== undefined) {
      compiles(value.pathMatches, ['pathMatches'], ctx);
    }
  });

const callbackCheckSchema = z
  .looseObject({
    body: callbackBodySchema.optional(),
    header: callbackHeaderSchema.optional(),
    signature: z.literal('verified').optional(),
  })
  .superRefine((value, ctx) => {
    const given = [value.body, value.header, value.signature].filter((v) => v !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({ code: 'custom', message: 'each expect entry is exactly one of body, header or signature' });
    }
  });

/** `type: callback` (spec §2.1): the same shape on a request file and on a sequence step. */
export const callbackAssertionSchema = z.looseObject({
  type: z.literal('callback'),
  catchUrl: z.string().min(1).max(CALLBACK_LIMITS.maxCatchUrlLength),
  withinMs: z
    .number()
    .int()
    .min(CALLBACK_LIMITS.minWithinMs)
    .max(CALLBACK_LIMITS.maxWithinMs)
    .default(CALLBACK_LIMITS.defaultWithinMs),
  match: callbackMatchSchema.default({}),
  expect: z.array(callbackCheckSchema).max(CALLBACK_LIMITS.maxExpectChecks).default([]),
  name,
});

type CheckFields = {
  readonly equals?: string | undefined;
  readonly matches?: string | undefined;
  readonly exists?: boolean | undefined;
};

function checkOf(raw: CheckFields): Pick<CallbackHeaderCheck, 'equals' | 'matches' | 'exists'> {
  return {
    ...(raw.equals !== undefined ? { equals: raw.equals } : {}),
    ...(raw.matches !== undefined ? { matches: raw.matches } : {}),
    ...(raw.exists !== undefined ? { exists: raw.exists } : {}),
  };
}

const toHeader = (raw: CheckFields & { readonly name: string }): CallbackHeaderCheck => ({
  name: raw.name,
  ...checkOf(raw),
});

const toBody = (
  raw: CheckFields & { readonly language: 'jsonpath' | 'xpath'; readonly path: string },
): CallbackBodyCheck => ({
  language: raw.language,
  path: raw.path,
  ...checkOf(raw),
});

function toCheck(check: CallbackCheck | z.output<typeof callbackCheckSchema>): CallbackCheck {
  if ('body' in check && check.body !== undefined) return { body: toBody(check.body) };
  if ('header' in check && check.header !== undefined) return { header: toHeader(check.header) };
  return { signature: 'verified' };
}

/**
 * Only the fields a callback assertion defines, at every level. `looseObject` keeps unknown keys on
 * the parsed value; dropping them here keeps them from being written back.
 */
export function toCallbackAssertion(
  raw: CallbackAssertion | z.output<typeof callbackAssertionSchema>,
): CallbackAssertion {
  const match = raw.match;
  return {
    type: 'callback',
    catchUrl: raw.catchUrl,
    withinMs: raw.withinMs,
    match: {
      ...(match.method !== undefined ? { method: match.method } : {}),
      ...(match.path !== undefined ? { path: match.path } : {}),
      ...(match.pathMatches !== undefined ? { pathMatches: match.pathMatches } : {}),
      ...(match.headers !== undefined ? { headers: match.headers.map(toHeader) } : {}),
      ...(match.body !== undefined ? { body: toBody(match.body) } : {}),
    },
    expect: raw.expect.map(toCheck),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
  };
}

const assertionSchema = z
  .discriminatedUnion('type', [
    statusSchema,
    soapFaultSchema,
    matchSchema,
    schemaSchema,
    slaSchema,
    callbackAssertionSchema,
  ])
  .superRefine(refineCheck);

/** The `assertions:` list of a request file. `looseObject` like every project schema; see `project/schema.ts`. */
export const assertionsSchema = z.array(assertionSchema);

/**
 * The `assertions:` list of a sequence step: the request catalogue plus `header`.
 */
export const stepAssertionsSchema = z.array(
  z
    .discriminatedUnion('type', [
      statusSchema,
      soapFaultSchema,
      matchSchema,
      schemaSchema,
      slaSchema,
      headerSchema,
      callbackAssertionSchema,
    ])
    .superRefine(refineCheck),
);
