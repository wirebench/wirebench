/**
 * A sequence: saved requests run in order, each able to lift values out of its response for the steps
 * after it (`${#Sequence#name}`) and to assert on it. One file per sequence under `sequences/`, with its
 * own `version`, outside the project `formatVersion` (ADR-0003, update of 2026-09-28).
 *
 * The limits here bound what a file from someone else can make a run hold in memory; the security
 * reasoning is in `docs/specs/2026-09-28-sequences-design.md` and ADR-0015.
 */

import type {
  AssertionLanguage,
  HeaderAssertion,
  MatchAssertion,
  SoapFaultAssertion,
  StatusAssertion,
  StepAssertion,
} from '../assert/model.js';
import { generateId } from '../project/model.js';
import type { CreateOptions } from '../project/model.js';
import { slugify } from '../project/paths.js';

/**
 * The highest sequence file version this build reads. Version 2 added `branches` (#347); a sequence
 * without any is still written as version 1, so a build that predates branches keeps reading it.
 */
export const SEQUENCE_VERSION = 2;

/** Bounds on one sequence file and one run, whatever the file or the server says. */
export const SEQUENCE_LIMITS = Object.freeze({
  /** A file larger than this is refused before it is parsed. */
  fileBytes: 256 * 1024,
  steps: 100,
  transfersPerStep: 50,
  assertionsPerStep: 50,
  /** A transferred value larger than this errors the step (`sequence-value-too-large`). */
  valueBytes: 64 * 1024,
  /** Branch rules on one step. */
  branchesPerStep: 20,
  /** The largest `max` a `goto` or `repeat` rule may have. */
  branchMax: 100,
  /** The longest wait a rule may ask for before it jumps. */
  branchDelayMs: 60_000,
  /**
   * Step runs in one run, whatever the rules say: each rule's `max` bounds its own loop, and this bounds
   * loops nested in loops. Reaching it errors the step that would run next (`sequence-run-limit`).
   */
  stepRuns: 1000,
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

/** A step outcome, as an `outcome` condition compares it. */
export type BranchOutcome = 'passed' | 'failed' | 'errored';

/** Holds when the step's own outcome is one of `equals`: what lets a send error branch. */
export interface OutcomeCondition {
  readonly type: 'outcome';
  readonly equals: BranchOutcome | readonly BranchOutcome[];
}

/**
 * What a branch rule tests about the step's response: one of the step checks, holding when the same
 * check as an assertion would pass, or the step's outcome. `not` inverts it.
 */
export type BranchCondition = (
  | Omit<StatusAssertion, 'name'>
  | Omit<HeaderAssertion, 'name'>
  | Omit<MatchAssertion, 'name'>
  | Omit<SoapFaultAssertion, 'name'>
  | OutcomeCondition
) & { readonly not?: boolean };

/** Where the run goes when a rule's condition holds. */
export type BranchRule =
  | {
      readonly when: BranchCondition;
      /** Continue at the step with this id; may be the step itself. */
      readonly then: 'goto';
      readonly step: string;
      /** How many times this rule may fire in one run. Every loop has one. */
      readonly max: number;
      readonly delayMs?: number;
    }
  | {
      readonly when: BranchCondition;
      /** Run this step again. */
      readonly then: 'repeat';
      readonly max: number;
      readonly delayMs?: number;
    }
  | {
      readonly when: BranchCondition;
      /** Report the next step as skipped and continue after it. It cannot loop, so it has no `max`. */
      readonly then: 'skip-next';
    };

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
  /** Evaluated in order after the step; the first that holds and is under its `max` decides where to go. */
  readonly branches?: readonly BranchRule[];
}

/** How a sequence runs. */
export interface SequenceSettings {
  /** After a failed or errored step, the rest are `skipped`. */
  readonly stopOnFailure: boolean;
  /** Overrides each request's own timeout for every step. */
  readonly stepTimeoutMs?: number;
}

/** A whole sequence, as loaded from (or saved to) `sequences/<slug>.sequence.yaml`. */
export interface SequenceDef {
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
export function createSequence(name: string, input: CreateSequenceInput = {}): SequenceDef {
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
  readonly branches?: readonly BranchRule[];
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
    ...(input.branches !== undefined && input.branches.length > 0 ? { branches: input.branches } : {}),
  };
}
