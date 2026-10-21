import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import {
  applyConversions,
  normaliseSelector,
  proposeConversions,
  runSelectorOf,
  saveProject,
  selectorCovers,
  selectRequests,
} from '@wirebench/engine';
import type { ConversionRefusal, LevelProposal, Project } from '@wirebench/engine';
import type { FeatureArgs, ScriptsConvertArgs } from '../args.js';
import { featuresFor } from '../features.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { loadTarget } from './run.js';

/** Where the backups live, relative to the project root (spec §7). */
const BACKUP_DIR = 'imported-scripts';
/** Lines of unchanged text around each change in a diff hunk. */
const CONTEXT = 3;
/** Above this many line pairs the diff is one hunk replacing the whole text: no quadratic table. */
const MAX_DIFF_CELLS = 4_000_000;

const PHASES = ['pre', 'post'] as const;

/**
 * `wirebench scripts convert`: the project's layered levels rewritten to the typed API, through the
 * same engine functions the desktop's review uses. Without `--write` it prints each level's diff and
 * TODOs and writes nothing. With it, it lists `imported-scripts/` afresh, applies, writes each backup
 * with an exclusive create (any failure stops before the save), then saves the project.
 */
export async function scriptsConvertCommand(args: ScriptsConvertArgs & FeatureArgs, io: CliIo): Promise<ExitCode> {
  const target = await loadTarget(args.path, io, ExitCode.RunError, featuresFor(args, io));
  if (typeof target === 'number') {
    return target;
  }
  const { project } = target;
  const taken = await listBackups(args.path);
  if (!(taken instanceof Set)) {
    io.stderr.write(`backup-failed: ${BACKUP_DIR}/ cannot be listed: ${taken.message}\n`);
    return ExitCode.RunError;
  }
  const levels = selectLevels(project, proposeConversions(project, undefined, taken), args.selectors);
  if ('unmatched' in levels) {
    io.stderr.write(`selector-unmatched: selector matched nothing: ${levels.unmatched.join(', ')}\n`);
    return ExitCode.Usage;
  }
  if (levels.length === 0) {
    io.stdout.write('No imported scripts to convert.\n');
    return ExitCode.Ok;
  }
  return args.write ? await write(args.path, project, levels, taken, io) : preview(levels, io);
}

/** Prints each level's diff and TODOs, and a total. */
function preview(levels: readonly LevelProposal[], io: CliIo): ExitCode {
  for (const level of levels) {
    const { result } = level;
    if (!result.ok) {
      io.stdout.write(`${skipped(level)}\n\n`);
      continue;
    }
    io.stdout.write(`${title(level)}\n`);
    for (const phase of PHASES) {
      const after = result[phase];
      if (after === undefined) continue;
      io.stdout.write(unifiedDiff(level.before[phase] ?? '', after, `${phase} (${level.dialect})`, `${phase} (typed)`));
      const todos = result.todos.filter((todo) => todo.phase === phase);
      if (todos.length > 0) {
        io.stdout.write(`TODOs in ${phase}:\n`);
        for (const todo of todos) io.stdout.write(`  line ${todo.line}: ${todo.call} — ${todo.reason}\n`);
      }
    }
    io.stdout.write('\n');
  }
  io.stdout.write(`${total(levels)}\nNothing written; run with --write to convert.\n`);
  return ExitCode.Ok;
}

/** Applies every level that converts: backups first, each created new; then the save. */
async function write(
  root: string,
  project: Project,
  levels: readonly LevelProposal[],
  taken: ReadonlySet<string>,
  io: CliIo,
): Promise<ExitCode> {
  const accepted = levels.filter((level) => level.result.ok);
  const { project: converted, applied, refused } = applyConversions(project, accepted, taken);
  const backupsRoot = resolve(root, BACKUP_DIR);
  for (const backup of applied.flatMap((level) => level.backups)) {
    const absolute = resolve(root, backup.path);
    if (!absolute.startsWith(`${backupsRoot}${sep}`)) {
      io.stderr.write(`backup-failed: ${backup.path} is outside ${BACKUP_DIR}/; the project was not saved\n`);
      return ExitCode.RunError;
    }
    try {
      await mkdir(dirname(absolute), { recursive: true });
      // `wx`: an existing file is never overwritten; a clash means the listing is stale.
      await writeFile(absolute, backup.source, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      io.stderr.write(
        `backup-failed: ${backup.path}: ${messageOf(error)}; the project is not saved; backups already written stay in ${BACKUP_DIR}/\n`,
      );
      return ExitCode.RunError;
    }
  }
  if (applied.length > 0) {
    try {
      await saveProject(converted, root);
    } catch (error) {
      io.stderr.write(`save-failed: ${messageOf(error)}; the backups written stay in ${BACKUP_DIR}/\n`);
      return ExitCode.RunError;
    }
  }
  const appliedIds = new Set(applied.map((level) => level.ownerId));
  const refusedWhy = new Map(refused.map((refusal) => [refusal.ownerId, refusal.reason]));
  for (const level of levels) {
    if (!level.result.ok) {
      io.stdout.write(`${skipped(level)}\n`);
    } else if (appliedIds.has(level.ownerId)) {
      const done = applied.find((each) => each.ownerId === level.ownerId) ?? level;
      const result = done.result.ok ? done.result : { mapped: 0, todos: [] };
      io.stdout.write(`Converted ${title(level)}: ${counts(result.mapped, result.todos.length)}\n`);
      for (const backup of done.backups) io.stdout.write(`  backup: ${backup.path}\n`);
    } else {
      io.stdout.write(`${title(level)}: skipped (${refusalText(refusedWhy.get(level.ownerId))})\n`);
    }
  }
  io.stdout.write(`Converted ${total(applied, levels.length - applied.length)}.\n`);
  return ExitCode.Ok;
}

/** Why a level was refused, as the output says it; ids are not checked unique, so a copied file can share one. */
function refusalText(reason: ConversionRefusal | undefined): string {
  if (reason === 'duplicate-id') return 'another level has the same id';
  return reason ?? 'not applied';
}

const title = (level: LevelProposal): string => `${level.path.join(' / ')} (${level.dialect})`;

/** A level that does not convert: its phase, its line when it has one, and why. */
function skipped(level: LevelProposal): string {
  const { result } = level;
  if (result.ok) return title(level);
  const where = result.line > 0 ? `${result.phase} line ${result.line}` : result.phase;
  return `${title(level)}: skipped, ${where}: ${result.message}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const counts = (mapped: number, todos: number): string => `${plural(mapped, 'mapped call')}, ${plural(todos, 'TODO')}`;

/** `2 levels, 5 mapped calls, 1 TODO, 1 skipped`: the levels that convert, and those that do not. */
function total(levels: readonly LevelProposal[], skippedCount?: number): string {
  let levelCount = 0;
  let mapped = 0;
  let todos = 0;
  let notConverted = 0;
  for (const { result } of levels) {
    if (!result.ok) {
      notConverted += 1;
      continue;
    }
    levelCount += 1;
    mapped += result.mapped;
    todos += result.todos.length;
  }
  const skips = skippedCount ?? notConverted;
  return `${plural(levelCount, 'level')}, ${counts(mapped, todos)}${skips > 0 ? `, ${skips} skipped` : ''}`;
}

/** Every file under `imported-scripts/`, as project-relative `/` paths; none when the folder is absent. */
async function listBackups(root: string): Promise<Set<string> | Error> {
  const dir = join(root, BACKUP_DIR);
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => !entry.isDirectory())
        .map((entry) => posix.join(BACKUP_DIR, ...relative(dir, join(entry.parentPath, entry.name)).split(sep))),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Set();
    return error instanceof Error ? error : new Error(String(error));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The levels the selectors cover, in explorer order, each once. A selector is a display path or a
 * path on disk, as `wirebench run` takes it, and covers the levels at or below it: `Shop` covers the
 * API level and everything in it, `Shop/Carts` the folder and its requests. A level's path on disk
 * is its request's, or for an API, interface or folder the matching prefix of a request's below it
 * (a level with no runnable request below it is reached by its display path only). A selector that
 * covers neither a level nor a request is unmatched; one that covers only typed scripts selects
 * nothing.
 */
function selectLevels(
  project: Project,
  all: readonly LevelProposal[],
  selectors: readonly string[],
): readonly LevelProposal[] | { readonly unmatched: readonly string[] } {
  if (selectors.length === 0) return all;
  const wanted = selectors.map(normaliseSelector);
  const located = all.map((level) => {
    const display = level.path.join('/');
    return { level, display, disk: diskPathOf(project, level.ownerId, display) };
  });
  const matches = (selector: string, at: (typeof located)[number]): boolean =>
    selectorCovers(selector, at.display) || (at.disk !== undefined && selectorCovers(selector, at.disk));
  const unmatched = selectors.filter(
    (selector, index) =>
      !located.some((at) => matches(wanted[index]!, at)) && selectRequests(project, [selector]).unmatched.length > 0,
  );
  if (unmatched.length > 0) return { unmatched };
  return located.filter((at) => wanted.some((selector) => matches(selector, at))).map((at) => at.level);
}

/** The level's path on disk, without a file suffix; undefined when no runnable request is at or below it. */
function diskPathOf(project: Project, ownerId: string, display: string): string | undefined {
  const own = runSelectorOf(project, ownerId);
  if (own !== undefined) return own;
  const below = selectRequests(project, [display]).selected.find((each) => each.path.startsWith(`${display}/`));
  const disk = below !== undefined ? runSelectorOf(project, below.request.id) : undefined;
  if (below === undefined || disk === undefined) return undefined;
  const deeper = below.path.slice(display.length + 1).split('/').length;
  const parts = disk.split('/');
  return parts.length > deeper ? parts.slice(0, parts.length - deeper).join('/') : undefined;
}

/** A text's lines, without the empty one a final line end leaves. */
function linesOf(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type Edit = { readonly kind: ' ' | '-' | '+'; readonly line: string };

/** The line edits from `a` to `b`: a longest common subsequence after trimming the common ends. */
function lineEdits(a: readonly string[], b: readonly string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head: Edit[] = a.slice(0, start).map((line) => ({ kind: ' ', line }));
  const tail: Edit[] = a.slice(endA).map((line) => ({ kind: ' ', line }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_DIFF_CELLS) {
    return [
      ...head,
      ...midA.map((line): Edit => ({ kind: '-', line })),
      ...midB.map((line): Edit => ({ kind: '+', line })),
      ...tail,
    ];
  }
  // lengths[i][j]: the LCS of midA[i..] and midB[j..], in one flat table.
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        midA[i] === midB[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  const middle: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      middle.push({ kind: ' ', line: midA[i]! });
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) {
      // On a tie the removal goes first, as `diff -u` prints a replaced block.
      middle.push({ kind: '-', line: midA[i]! });
      i += 1;
    } else {
      middle.push({ kind: '+', line: midB[j]! });
      j += 1;
    }
  }
  return [...head, ...middle, ...tail];
}

/** A unified diff of two texts with {@link CONTEXT} lines around each change; empty when they are equal. */
export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string): string {
  const edits = lineEdits(linesOf(before), linesOf(after));
  const changed = edits.flatMap((edit, index) => (edit.kind === ' ' ? [] : [index]));
  if (changed.length === 0) return '';
  // Group the changes whose context would touch or overlap into one hunk.
  const hunks: { from: number; to: number }[] = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(edits.length, index + CONTEXT + 1);
    const last = hunks.at(-1);
    if (last !== undefined && from <= last.to) last.to = to;
    else hunks.push({ from, to });
  }
  let out = `--- ${fromLabel}\n+++ ${toLabel}\n`;
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const hunk of hunks) {
    for (; cursor < hunk.from; cursor += 1) {
      const kind = edits[cursor]!.kind;
      if (kind !== '+') oldLine += 1;
      if (kind !== '-') newLine += 1;
    }
    const body = edits.slice(hunk.from, hunk.to);
    const oldCount = body.filter((edit) => edit.kind !== '+').length;
    const newCount = body.filter((edit) => edit.kind !== '-').length;
    out += `@@ -${range(oldLine, oldCount)} +${range(newLine, newCount)} @@\n`;
    for (const edit of body) out += `${edit.kind}${edit.line}\n`;
    for (; cursor < hunk.to; cursor += 1) {
      const kind = edits[cursor]!.kind;
      if (kind !== '+') oldLine += 1;
      if (kind !== '-') newLine += 1;
    }
  }
  return out;
}

/** A hunk range as `diff -u` writes it: `start,count`, `start` alone for one line, the line before for none. */
function range(start: number, count: number): string {
  if (count === 1) return `${start}`;
  return `${count === 0 ? start - 1 : start},${count}`;
}
