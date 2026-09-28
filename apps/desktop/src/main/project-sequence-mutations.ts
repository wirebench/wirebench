/**
 * The `*-sequence` project changes, and the wire form of a sequence.
 *
 * Every edit is re-read through the engine's own file parser before it is accepted (`validated`), so
 * the limits, the transfer-name pattern and the compiled `matches:` hold for an edit made here exactly
 * as they hold for a file pulled from a teammate; the IPC schema checks structure only.
 */

import {
  ProjectError,
  createSequence,
  generateId,
  isWirebenchError,
  parseSequenceFile,
  sequenceDocument,
  sequenceFilePath,
  uniqueSlug,
} from '@wirebench/engine';
import type { Project, SequenceDef, SequenceStep, StepAssertion, Transfer } from '@wirebench/engine';
import type {
  SequencePatch,
  SequenceStepWire,
  SequenceTransferWire,
  SequenceWire,
  StepAssertionWire,
} from '../shared/wire-types.js';

/** The outcome of one sequence change. */
export interface SequenceMutationResult {
  readonly project: Project;
  readonly createdId?: string;
}

function requireSequence(project: Project, sequenceId: string): SequenceDef {
  const sequence = project.sequences.find((candidate) => candidate.id === sequenceId);
  if (sequence === undefined) {
    throw new ProjectError('unknown-entity', `No sequence with id "${sequenceId}"`, { details: { sequenceId } });
  }
  return sequence;
}

/**
 * The slugs a new or renamed sequence may not take: every other sequence's, and `reserved`, the files
 * under `sequences/` this build could not load. Taking one of those would make the next save refuse
 * (`sequence-file-conflict`) rather than write over a file the user has not seen.
 */
function takenSlugs(project: Project, reserved: ReadonlySet<string>, except?: string): Set<string> {
  return new Set([
    ...project.sequences.filter((sequence) => sequence.id !== except).map((sequence) => sequence.slug),
    ...reserved,
  ]);
}

/** Keeps `order` dense after a removal, so the explorer and the files agree. */
function renumber(sequences: readonly SequenceDef[]): SequenceDef[] {
  return sequences.map((sequence, order) => (sequence.order === order ? sequence : { ...sequence, order }));
}

/**
 * `sequence` as its file would read back, or a `sequence-invalid` error naming what is wrong: the same
 * checks a file from a teammate goes through.
 */
function validated(sequence: SequenceDef): SequenceDef {
  try {
    return parseSequenceFile(sequenceDocument(sequence), sequenceFilePath(sequence.slug), sequence.slug);
  } catch (error) {
    if (isWirebenchError(error) && error.code === 'sequence-file-invalid') {
      const issues = (error.details?.['issues'] as readonly { path: string; message: string }[] | undefined) ?? [];
      const detail = issues.map((issue) => (issue.path !== '' ? `${issue.path}: ${issue.message}` : issue.message));
      throw new ProjectError('sequence-invalid', `The sequence is not valid: ${detail.join('; ') || error.message}`, {
        details: { issues },
      });
    }
    throw error;
  }
}

function toTransfer(wire: SequenceTransferWire): Transfer {
  const base = {
    name: wire.name,
    ...(wire.secret === true ? { secret: true } : {}),
    ...(wire.optional === true ? { optional: true } : {}),
  };
  switch (wire.from) {
    case 'body':
      return {
        ...base,
        from: 'body',
        language: wire.language,
        expression: wire.expression,
        ...(wire.namespaces !== undefined ? { namespaces: wire.namespaces } : {}),
      };
    case 'header':
      return { ...base, from: 'header', header: wire.header };
    case 'status':
      return { ...base, from: 'status' };
    case 'cookie':
      return { ...base, from: 'cookie', cookie: wire.cookie };
  }
}

/** Drops `undefined` members, which the wire allows and the engine's exact optional types do not. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function toStep(wire: SequenceStepWire): SequenceStep {
  return {
    id: wire.id,
    ...(wire.name !== undefined && wire.name !== '' ? { name: wire.name } : {}),
    requestId: wire.requestId,
    enabled: wire.enabled,
    requestAssertions: wire.requestAssertions,
    transfers: wire.transfers.map(toTransfer),
    assertions: wire.assertions.map((assertion) => defined(assertion) as StepAssertion),
  };
}

/** Adds an empty sequence at the end of the project's list. */
export function addSequence(
  project: Project,
  name: string,
  reserved: ReadonlySet<string> = new Set(),
): SequenceMutationResult {
  const sequence = validated(
    createSequence(name, { slug: uniqueSlug(name, takenSlugs(project, reserved)), order: project.sequences.length }),
  );
  return { project: { ...project, sequences: [...project.sequences, sequence] }, createdId: sequence.id };
}

/** Applies a patch. The steps are replaced whole; a new name takes a new slug, so the file is renamed. */
export function updateSequence(
  project: Project,
  sequenceId: string,
  patch: SequencePatch,
  reserved: ReadonlySet<string> = new Set(),
): SequenceMutationResult {
  const current = requireSequence(project, sequenceId);
  const renamed = patch.name !== undefined && patch.name !== current.name;
  const description = patch.description ?? current.description;
  const next = validated({
    id: current.id,
    name: patch.name ?? current.name,
    slug: renamed ? uniqueSlug(patch.name ?? current.name, takenSlugs(project, reserved, sequenceId)) : current.slug,
    order: current.order,
    ...(description !== undefined && description !== '' ? { description } : {}),
    settings:
      patch.settings === undefined
        ? current.settings
        : {
            stopOnFailure: patch.settings.stopOnFailure,
            ...(patch.settings.stepTimeoutMs !== undefined ? { stepTimeoutMs: patch.settings.stepTimeoutMs } : {}),
          },
    steps: patch.steps === undefined ? current.steps : patch.steps.map(toStep),
  });
  return {
    project: {
      ...project,
      sequences: project.sequences.map((sequence) => (sequence.id === sequenceId ? next : sequence)),
    },
  };
}

/** Removes a sequence; its file goes on the next save. */
export function removeSequence(project: Project, sequenceId: string): SequenceMutationResult {
  requireSequence(project, sequenceId);
  return {
    project: { ...project, sequences: renumber(project.sequences.filter((sequence) => sequence.id !== sequenceId)) },
  };
}

/** Copies a sequence under a new name, with new ids for it and each of its steps. */
export function duplicateSequence(
  project: Project,
  sequenceId: string,
  reserved: ReadonlySet<string> = new Set(),
): SequenceMutationResult {
  const source = requireSequence(project, sequenceId);
  const name = `${source.name} copy`;
  const copy = validated({
    ...source,
    id: generateId(),
    name,
    slug: uniqueSlug(name, takenSlugs(project, reserved)),
    order: project.sequences.length,
    steps: source.steps.map((step) => ({ ...step, id: generateId() })),
  });
  return { project: { ...project, sequences: [...project.sequences, copy] }, createdId: copy.id };
}

/** The slugs of the sequence files a load refused, from its problems: what a new slug must avoid. */
export function refusedSequenceSlugs(
  problems: readonly { readonly code: string; readonly file: string }[],
): Set<string> {
  const slugs = new Set<string>();
  for (const problem of problems) {
    const match = /^sequences\/(.+)\.sequence\.yaml$/.exec(problem.file);
    if (problem.code.startsWith('sequence-') && match?.[1] !== undefined) {
      slugs.add(match[1]);
    }
  }
  return slugs;
}

/** A sequence as the renderer sees it. */
export function toSequenceWire(sequence: SequenceDef): SequenceWire {
  return {
    id: sequence.id,
    name: sequence.name,
    slug: sequence.slug,
    order: sequence.order,
    ...(sequence.description !== undefined ? { description: sequence.description } : {}),
    settings: { ...sequence.settings },
    steps: sequence.steps.map((step) => ({
      id: step.id,
      ...(step.name !== undefined ? { name: step.name } : {}),
      requestId: step.requestId,
      enabled: step.enabled,
      requestAssertions: step.requestAssertions,
      transfers: step.transfers.map((transfer) => ({ ...transfer })),
      assertions: step.assertions.map((assertion) => ({ ...assertion }) as StepAssertionWire),
    })),
  };
}
