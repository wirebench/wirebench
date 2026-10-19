/**
 * Converting imported scripts in the desktop (convert-imported-scripts spec §4.2, §7): the listing of
 * `imported-scripts/` a proposal and an Accept each take afresh, and the review's proposals and the
 * Accept's outcome as they cross the wire. The engine converts (`proposeConversions`,
 * `applyConversions`); `ProjectHost` writes the backups and saves.
 */

import { readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { containersOf, IMPORTED_SCRIPTS_DIR } from '@wirebench/engine';
import type { LevelProposal, Project, ScriptDiagnostic, ScriptPhase } from '@wirebench/engine';
import type { ScriptConversionWire, ScriptConversionsResultWire } from '../shared/wire-base.js';
import type { ScriptConversions } from './project-script-mutations.js';

const PHASES = ['pre', 'post'] as const;

/** The protocols whose levels carry scripts, as their container kinds are named. */
const SCRIPTED_KINDS = ['soap', 'rest', 'grpc', 'mcp'] as const;

/**
 * Every file under the project's `imported-scripts/`, as project-relative `/` paths; none when the
 * folder is absent. A backup's name depends on what is there, so each proposal and each Accept lists
 * it again rather than trusting an earlier listing.
 */
export async function listImportedScripts(projectDir: string): Promise<Set<string>> {
  const dir = join(projectDir, IMPORTED_SCRIPTS_DIR);
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => !entry.isDirectory())
        .map((entry) =>
          posix.join(IMPORTED_SCRIPTS_DIR, ...relative(dir, join(entry.parentPath, entry.name)).split(sep)),
        ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

/** Something in a container's tree that can carry scripts, as far as finding it by id goes. */
interface Node {
  readonly id: string;
  readonly scripts?: { readonly secrets: readonly string[] };
  readonly folders?: readonly Node[];
  readonly requests?: readonly Node[];
  readonly operations?: readonly { readonly requests: readonly Node[] }[];
}

function find(node: Node, id: string): Node | undefined {
  if (node.id === id) return node;
  for (const folder of node.folders ?? []) {
    const found = find(folder, id);
    if (found !== undefined) return found;
  }
  return (
    (node.requests ?? []).find((request) => request.id === id) ??
    (node.operations ?? []).flatMap((operation) => operation.requests).find((request) => request.id === id)
  );
}

/** What a level's converted scripts are checked with. */
export interface ConvertedLevelContext {
  /** The kind of the container that holds the level. */
  readonly protocol: string;
  /** The secrets the level's scripts list, which `secrets.get` may name. */
  readonly secrets: readonly string[];
}

/** The protocol and secrets of the level with this id, or `undefined` when no container holds it. */
export function levelContext(project: Project, ownerId: string): ConvertedLevelContext | undefined {
  for (const kind of SCRIPTED_KINDS) {
    for (const container of containersOf(project, kind) as readonly Node[]) {
      const found = find(container, ownerId);
      if (found !== undefined) return { protocol: kind, secrets: found.scripts?.secrets ?? [] };
    }
  }
  return undefined;
}

/** Checks a converted phase as the Scripts tab would once the level is typed. */
export type CheckConverted = (
  ownerId: string,
  level: ConvertedLevelContext,
  phase: ScriptPhase,
  source: string,
) => Promise<readonly ScriptDiagnostic[]>;

/** One proposal as the review shows it, the converted phases checked by `check`. */
export async function conversionWire(
  project: Project,
  proposal: LevelProposal,
  check: CheckConverted,
): Promise<ScriptConversionWire> {
  const { result } = proposal;
  const common = {
    ownerId: proposal.ownerId,
    path: [...proposal.path],
    dialect: proposal.dialect,
    before: { ...proposal.before },
    backups: proposal.backups.map((backup) => backup.path),
    fingerprint: proposal.fingerprint,
  };
  if (!result.ok) {
    // Line 0 means the script was refused for a reason with no line; the wire leaves it out.
    return {
      ...common,
      result: {
        ok: false,
        phase: result.phase,
        ...(result.line > 0 ? { line: result.line } : {}),
        message: result.message,
      },
    };
  }
  const level = levelContext(project, proposal.ownerId) ?? { protocol: 'rest', secrets: [] };
  const problems: { pre?: ScriptDiagnostic[]; post?: ScriptDiagnostic[] } = {};
  for (const phase of PHASES) {
    const text = result[phase];
    if (text !== undefined) problems[phase] = [...(await check(proposal.ownerId, level, phase, text))];
  }
  const count = (kind: string): number => result.todos.filter((todo) => todo.kind === kind).length;
  return {
    ...common,
    result: {
      ok: true,
      ...(result.pre !== undefined ? { pre: result.pre } : {}),
      ...(result.post !== undefined ? { post: result.post } : {}),
      mapped: result.mapped,
      todos: result.todos.map((todo) => ({ ...todo })),
      todoCounts: { unsupported: count('unsupported'), notMapped: count('not-mapped'), shadowed: count('shadowed') },
      problems,
    },
  };
}

/**
 * What a `convert-scripts` change did, for the dialog's report. A refused level's path is looked up
 * in `pathOf`, the levels of the model the change was applied to; empty when it is not there.
 */
export function conversionsResultWire(
  conversions: ScriptConversions,
  pathOf: (ownerId: string) => readonly string[] | undefined,
): ScriptConversionsResultWire {
  return {
    applied: conversions.applied.map((level) => ({
      ownerId: level.ownerId,
      path: [...level.path],
      backups: level.backups.map((backup) => backup.path),
      todos: level.result.ok ? level.result.todos.length : 0,
    })),
    refused: conversions.refused.map((refusal) => ({
      ownerId: refusal.ownerId,
      path: [...(pathOf(refusal.ownerId) ?? [])],
      reason: refusal.reason,
    })),
  };
}
