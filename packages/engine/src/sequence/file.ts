/**
 * `sequences/<slug>.sequence.yaml`: parsing, validation and serialisation of one sequence file.
 *
 * The file may come from a teammate or a branch just pulled, so it is untrusted input: its size is
 * checked before it is parsed, it is parsed with the project's YAML parser (core schema, aliases capped
 * by the library), and every count is bounded by {@link SEQUENCE_LIMITS}. It names requests only by id,
 * so nothing in it can name a path on disk.
 *
 * Like every project schema, objects are `looseObject`: an unknown key is ignored and not written back.
 * That is only safe because a file whose `version` is newer than {@link SEQUENCE_VERSION} is refused
 * whole rather than read in part, and a refused file is never deleted by a save (`save.ts`).
 */

import { z } from 'zod';
import { stepAssertionsSchema } from '../assert/schema.js';
import { ProjectError } from '../errors.js';
import { compact, parseYaml, stringifyYaml } from '../project/yaml.js';
import { SEQUENCE_LIMITS, SEQUENCE_VERSION, TRANSFER_NAME_PATTERN } from './model.js';
import type { StepAssertion } from '../assert/model.js';
import type { Sequence, SequenceStep, Transfer } from './model.js';

/** Directory holding every sequence file, beside `interfaces/` and `apis/`. */
export const SEQUENCES_DIR = 'sequences';
/** Suffix identifying a sequence file. */
export const SEQUENCE_SUFFIX = '.sequence.yaml';

const nonEmpty = z.string().min(1);

const transferBase = {
  name: z.string().regex(TRANSFER_NAME_PATTERN, 'a transfer name is a letter or _, then letters, digits, _ . or -'),
  secret: z.boolean().optional(),
  optional: z.boolean().optional(),
};

const transferSchema = z.discriminatedUnion('from', [
  z.looseObject({
    ...transferBase,
    from: z.literal('body'),
    language: z.enum(['xpath', 'xquery', 'jsonpath']),
    expression: nonEmpty,
    namespaces: z.record(z.string(), z.string()).optional(),
  }),
  z.looseObject({ ...transferBase, from: z.literal('header'), header: nonEmpty }),
  z.looseObject({ ...transferBase, from: z.literal('status') }),
]);

const stepSchema = z.looseObject({
  id: nonEmpty,
  name: z.string().optional(),
  request: nonEmpty,
  enabled: z.boolean().default(true),
  requestAssertions: z.boolean().default(true),
  transfers: z.array(transferSchema).max(SEQUENCE_LIMITS.transfersPerStep).default([]),
  assertions: stepAssertionsSchema.max(SEQUENCE_LIMITS.assertionsPerStep).default([]),
});

/** One sequence file, after its `kind` and `version` have been checked. */
export const sequenceFileSchema = z.looseObject({
  kind: z.literal('sequence'),
  version: z.literal(SEQUENCE_VERSION),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  settings: z
    .looseObject({
      stopOnFailure: z.boolean().default(true),
      stepTimeoutMs: z.number().int().positive().optional(),
    })
    .default({ stopOnFailure: true }),
  steps: z.array(stepSchema).max(SEQUENCE_LIMITS.steps).default([]),
});

/** The relative path of a sequence's file. */
export function sequenceFilePath(slug: string): string {
  return `${SEQUENCES_DIR}/${slug}${SEQUENCE_SUFFIX}`;
}

/** The slug a sequence file's name gives it, or `undefined` for a name that is not a sequence file. */
export function sequenceSlugOf(fileName: string): string | undefined {
  return fileName.endsWith(SEQUENCE_SUFFIX) && fileName.length > SEQUENCE_SUFFIX.length
    ? fileName.slice(0, -SEQUENCE_SUFFIX.length)
    : undefined;
}

function refuse(code: string, message: string, file: string, issues?: readonly object[]): never {
  throw new ProjectError(code, message, { details: { file, ...(issues !== undefined ? { issues } : {}) } });
}

/**
 * Parses one sequence file.
 *
 * @throws ProjectError `sequence-file-invalid` (too large, malformed YAML, not a sequence, or failing the
 * schema or a limit), `sequence-version-too-new` (a `version` above {@link SEQUENCE_VERSION})
 */
export function parseSequenceFile(bytes: Uint8Array | string, file: string, slug: string): Sequence {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
  if (size > SEQUENCE_LIMITS.fileBytes) {
    refuse('sequence-file-invalid', `${file} is larger than ${SEQUENCE_LIMITS.fileBytes} bytes`, file);
  }
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  let document: unknown;
  try {
    document = parseYaml(text, file);
  } catch (error) {
    refuse('sequence-file-invalid', `Malformed YAML in ${file}`, file, [
      { path: '', message: error instanceof Error ? error.message : String(error) },
    ]);
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    refuse('sequence-file-invalid', `${file} is not a sequence`, file);
  }
  const header = document as Record<string, unknown>;
  if (header['kind'] !== 'sequence') {
    refuse('sequence-file-invalid', `${file} is not a sequence (kind: ${String(header['kind'])})`, file);
  }
  const version = header['version'];
  if (typeof version === 'number' && Number.isInteger(version) && version > SEQUENCE_VERSION) {
    refuse(
      'sequence-version-too-new',
      `${file} was written by a newer version of Wirebench (sequence version ${version}); it was left as it is`,
      file,
    );
  }
  const result = sequenceFileSchema.safeParse(document);
  if (!result.success) {
    refuse(
      'sequence-file-invalid',
      `Invalid sequence file ${file}`,
      file,
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const parsed = result.data;
  return {
    id: parsed.id,
    name: parsed.name,
    slug,
    order: parsed.order,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    settings: {
      stopOnFailure: parsed.settings.stopOnFailure,
      ...(parsed.settings.stepTimeoutMs !== undefined ? { stepTimeoutMs: parsed.settings.stepTimeoutMs } : {}),
    },
    steps: parsed.steps.map((step): SequenceStep => ({
      id: step.id,
      ...(step.name !== undefined ? { name: step.name } : {}),
      requestId: step.request,
      enabled: step.enabled,
      requestAssertions: step.requestAssertions,
      transfers: step.transfers.map(toTransfer),
      assertions: step.assertions.map(knownAssertionFields),
    })),
  };
}

/**
 * Only the fields an assertion of its type defines. `looseObject` keeps unknown keys on the parsed value;
 * dropping them here is what keeps them from being written back.
 */
function knownAssertionFields(raw: StepAssertion | z.infer<typeof stepAssertionsSchema>[number]): StepAssertion {
  const name = raw.name !== undefined ? { name: raw.name } : {};
  switch (raw.type) {
    case 'status':
      return { type: 'status', equals: raw.equals, ...name };
    case 'soap-fault':
      return { type: 'soap-fault', expect: raw.expect, ...name };
    case 'schema':
      return { type: 'schema', ...name };
    case 'sla':
      return { type: 'sla', maxMs: raw.maxMs, ...name };
    case 'match':
      return {
        type: 'match',
        language: raw.language,
        expression: raw.expression,
        ...(raw.namespaces !== undefined ? { namespaces: raw.namespaces } : {}),
        ...(raw.equals !== undefined ? { equals: raw.equals } : {}),
        ...(raw.matches !== undefined ? { matches: raw.matches } : {}),
        ...(raw.exists !== undefined ? { exists: raw.exists } : {}),
        ...name,
      };
    case 'header':
      return {
        type: 'header',
        header: raw.header,
        ...(raw.equals !== undefined ? { equals: raw.equals } : {}),
        ...(raw.matches !== undefined ? { matches: raw.matches } : {}),
        ...(raw.exists !== undefined ? { exists: raw.exists } : {}),
        ...name,
      };
  }
}

function toTransfer(raw: z.infer<typeof transferSchema>): Transfer {
  const base = {
    name: raw.name,
    ...(raw.secret === true ? { secret: true } : {}),
    ...(raw.optional === true ? { optional: true } : {}),
  };
  switch (raw.from) {
    case 'body':
      return {
        ...base,
        from: 'body',
        language: raw.language,
        expression: raw.expression,
        ...(raw.namespaces !== undefined ? { namespaces: raw.namespaces } : {}),
      };
    case 'header':
      return { ...base, from: 'header', header: raw.header };
    case 'status':
      return { ...base, from: 'status' };
  }
}

/** Only the fields a transfer or assertion defines, in a stable shape; defaults are left out. */
function transferDocument(transfer: Transfer): Record<string, unknown> {
  return compact({
    name: transfer.name,
    from: transfer.from,
    language: transfer.from === 'body' ? transfer.language : undefined,
    expression: transfer.from === 'body' ? transfer.expression : undefined,
    namespaces: transfer.from === 'body' ? transfer.namespaces : undefined,
    header: transfer.from === 'header' ? transfer.header : undefined,
    secret: transfer.secret === true ? true : undefined,
    optional: transfer.optional === true ? true : undefined,
  });
}

/** Serialises a sequence as its file's content: keys sorted, defaults omitted, steps in order. */
export function sequenceDocument(sequence: Sequence): string {
  return stringifyYaml(
    compact({
      kind: 'sequence',
      version: SEQUENCE_VERSION,
      id: sequence.id,
      name: sequence.name,
      order: sequence.order,
      description: sequence.description,
      settings: compact({
        stopOnFailure: sequence.settings.stopOnFailure,
        stepTimeoutMs: sequence.settings.stepTimeoutMs,
      }),
      steps: sequence.steps.map((step) =>
        compact({
          id: step.id,
          name: step.name,
          request: step.requestId,
          enabled: step.enabled ? undefined : false,
          requestAssertions: step.requestAssertions ? undefined : false,
          transfers: step.transfers.length > 0 ? step.transfers.map(transferDocument) : undefined,
          assertions:
            step.assertions.length > 0
              ? step.assertions.map((a) => compact({ ...knownAssertionFields(a) }))
              : undefined,
        }),
      ),
    }),
  );
}
