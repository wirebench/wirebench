/**
 * A sequence: saved requests run in order, each able to lift values out of its response for the steps
 * after it (`${#Sequence#name}`) and to assert on it. One file per sequence under `sequences/`, with its
 * own `version`, outside the project `formatVersion` (ADR-0003, update of 2026-09-28).
 *
 * The limits here bound what a file from someone else can make a run hold in memory; the security
 * reasoning is in `docs/specs/2026-09-28-sequences-design.md` and ADR-0015.
 */

import type { AssertionLanguage, StepAssertion } from '../assert/model.js';
import { generateId } from '../project/model.js';
import type { CreateOptions } from '../project/model.js';
import { slugify } from '../project/paths.js';

/** The version of the sequence file this build writes and the highest it reads. */
export const SEQUENCE_VERSION = 1;

/** Bounds on one sequence file and one run, whatever the file or the server says. */
export const SEQUENCE_LIMITS = Object.freeze({
  /** A file larger than this is refused before it is parsed. */
  fileBytes: 256 * 1024,
  steps: 100,
  transfersPerStep: 50,
  assertionsPerStep: 50,
  /** A transferred value larger than this errors the step (`sequence-value-too-large`). */
  valueBytes: 64 * 1024,
});

/** A transfer's name, as `${#Sequence#name}` uses it. */
export const TRANSFER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

interface TransferBase {
  /** The name later steps use, as `${#Sequence#name}`. A later transfer of the same name replaces it. */
  readonly name: string;
  /** Masked everywhere from the moment it is extracted, and never shown or reported. */
  readonly secret?: boolean;
  /** Finding nothing leaves the name unset instead of failing the step. */
  readonly optional?: boolean;
}

/** Lifts the first result of an expression over the response body. */
export interface BodyTransfer extends TransferBase {
  readonly from: 'body';
  readonly language: AssertionLanguage;
  readonly expression: string;
  /** Prefix bindings for XPath/XQuery. Absent means the response's own prefixes. */
  readonly namespaces?: Readonly<Record<string, string>>;
}

/** Lifts the first value of a response header (gRPC: metadata, then trailers). */
export interface HeaderTransfer extends TransferBase {
  readonly from: 'header';
  readonly header: string;
}

/** Lifts the status: HTTP for SOAP and REST, the numeric gRPC status for gRPC. */
export interface StatusTransfer extends TransferBase {
  readonly from: 'status';
}

/**
 * Lifts the value of one cookie the response set (`Set-Cookie`; the last one of that name wins).
 *
 * Wirebench keeps no shared cookie jar, on purpose (`rest/cookies.ts`), and a sequence does not add
 * one: a step that needs a login's cookie says so, `Cookie: sid=${#Sequence#sid}`, where it can be
 * read and where ADR-0015's guards apply.
 */
export interface CookieTransfer extends TransferBase {
  readonly from: 'cookie';
  readonly cookie: string;
}

/** One value lifted from a step's response. */
export type Transfer = BodyTransfer | HeaderTransfer | StatusTransfer | CookieTransfer;

/** One request in a sequence, and what to take from and check about its response. */
export interface SequenceStep {
  readonly id: string;
  /** Defaults to the request's own name wherever it is shown. */
  readonly name?: string;
  /** A saved request's id: SOAP, REST or unary gRPC. Never a path, so a rename or a move keeps the step. */
  readonly requestId: string;
  /** A disabled step is reported as `skipped`. */
  readonly enabled: boolean;
  /** Whether the request's own `assertions:` run in this step, before the step's own. */
  readonly requestAssertions: boolean;
  readonly transfers: readonly Transfer[];
  readonly assertions: readonly StepAssertion[];
}

/** How a sequence runs. */
export interface SequenceSettings {
  /** After a failed or errored step, the rest are `skipped`. */
  readonly stopOnFailure: boolean;
  /** Overrides each request's own timeout for every step. */
  readonly stepTimeoutMs?: number;
}

/** A whole sequence, as loaded from (or saved to) `sequences/<slug>.sequence.yaml`. */
export interface Sequence {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly settings: SequenceSettings;
  readonly steps: readonly SequenceStep[];
}

/** The settings a new sequence starts with. */
export const DEFAULT_SEQUENCE_SETTINGS: SequenceSettings = Object.freeze({ stopOnFailure: true });

function idOf(options: CreateOptions | undefined): string {
  return options?.id ?? (options?.newId ?? generateId)();
}

/** Input to {@link createSequence} beyond the name. */
export interface CreateSequenceInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly settings?: SequenceSettings;
  readonly steps?: readonly SequenceStep[];
}

/** Creates a sequence, empty unless `input.steps` says otherwise. */
export function createSequence(name: string, input: CreateSequenceInput = {}): Sequence {
  return {
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    settings: input.settings ?? DEFAULT_SEQUENCE_SETTINGS,
    steps: input.steps ?? [],
  };
}

/** Input to {@link createSequenceStep} beyond the request id. */
export interface CreateSequenceStepInput extends Omit<CreateOptions, 'order'> {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly requestAssertions?: boolean;
  readonly transfers?: readonly Transfer[];
  readonly assertions?: readonly StepAssertion[];
}

/** Creates a step that sends `requestId`, enabled, with the request's own assertions on. */
export function createSequenceStep(requestId: string, input: CreateSequenceStepInput = {}): SequenceStep {
  return {
    id: idOf(input),
    ...(input.name !== undefined ? { name: input.name } : {}),
    requestId,
    enabled: input.enabled ?? true,
    requestAssertions: input.requestAssertions ?? true,
    transfers: input.transfers ?? [],
    assertions: input.assertions ?? [],
  };
}
