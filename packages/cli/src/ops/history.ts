/**
 * `history_list` and `history_diff` (spec §2): the desktop's History file for this project, read
 * fresh for each call so a send from the app or another agent shows at once.
 *
 * Both ops pass what they return through the URL redactor (spec §2.2): an item name, an endpoint-like
 * value quoted in a diff, or a parser message can all carry a URL with credentials. The diff reads
 * both responses through the same redaction as `validate` and `query` ({@link redactedMessage}) before
 * comparing, so two responses that differ only in a password compare equal and show neither.
 */
import { openHistory } from '@wirebench/engine';
import type { HistoryEntry, HistoryFile } from '@wirebench/engine';
import { diffSnapshot } from '@wirebench/engine/snapshot';
import type { SnapshotChange, SnapshotFormat } from '@wirebench/engine/snapshot';
import { z } from 'zod';
import { maskDeep } from '../reporters/mask.js';
import { defineOp } from './context.js';
import type { OpsContext } from './context.js';
import { OpsError } from './errors.js';
import { historyFileFor } from './paths.js';
import { openProject } from './project.js';
import { redactUrlsInText } from './redact.js';
import { redactedMessage } from './sources.js';
import type { RedactedMessage } from './sources.js';

export interface HistoryRow {
  readonly id: string;
  readonly at: string;
  /** The item path `send` takes, as it was when the entry was written. */
  readonly item: string;
  readonly kind: 'soap' | 'rest' | 'grpc' | 'websocket';
  readonly method?: string;
  /** Absent when the send got no response. */
  readonly status?: number;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly tags?: readonly string[];
}

export interface HistoryListResult {
  readonly entries: readonly HistoryRow[];
  /** How many entries matched, before the limit. */
  readonly total: number;
}

export interface DiffSide {
  readonly id: string;
  readonly at: string;
  readonly item: string;
  readonly status?: number;
}

export interface HistoryDiffResult {
  readonly from: DiffSide;
  readonly to: DiffSide;
  readonly format: SnapshotFormat;
  readonly changes: readonly SnapshotChange[];
  /** Changes an `ignore` path covered. */
  readonly ignored: number;
  /** Set when a body did not parse in its format and was compared as text. */
  readonly error?: string;
  /** The changes were cut at {@link MAX_DIFF_CHARS} characters in all; the rest are not listed. */
  readonly truncated: boolean;
}

/** The most characters (paths and values) the changes of one diff may hold in all: 256 KiB. */
export const MAX_DIFF_CHARS = 256 * 1024;

/** `Interface/Operation/Request` for SOAP; `API/Folder/…/Request` for REST, gRPC and WebSocket. */
export function historyItemOf(entry: HistoryEntry): string {
  // A SOAP operation name is one path segment, however it is spelled; a REST folder chain is joined by ' / '.
  const middle =
    entry.kind === undefined || entry.kind === 'soap' ? [entry.operationName] : entry.operationName.split(' / ');
  return [entry.interfaceName, ...middle.filter((part) => part.length > 0), entry.requestName].join('/');
}

async function historyOf(context: OpsContext): Promise<HistoryFile> {
  const { project } = await openProject(context);
  return openHistory(historyFileFor(context.historyDir, project.id));
}

const listInput = z.object({
  item: z.string().min(1).optional().describe('Only entries whose item path contains this text (any case)'),
  limit: z.number().int().min(1).max(200).default(20).describe('How many entries, newest first (1 to 200, default 20)'),
});

export const historyListOp = defineOp({
  name: 'history_list',
  title: 'List History',
  description:
    "Lists the project's History, newest first: id, time, item, status and duration of each send, the " +
    "desktop's and agents' alike. Reads only.",
  input: listInput,
  async run(value, context): Promise<HistoryListResult> {
    const history = await historyOf(context);
    const needle = value.item?.toLowerCase();
    const matching = history
      .list({ limit: history.count() })
      .filter((entry) => needle === undefined || historyItemOf(entry).toLowerCase().includes(needle));
    const result: HistoryListResult = {
      entries: matching.slice(0, value.limit).map((entry) => ({
        id: entry.id,
        at: entry.at,
        item: historyItemOf(entry),
        kind: entry.kind ?? 'soap',
        ...(entry.method !== undefined ? { method: entry.method } : {}),
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        ok: entry.ok,
        durationMs: entry.durationMs,
        ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
      })),
      total: matching.length,
    };
    return maskDeep(result, redactUrlsInText) as HistoryListResult;
  },
});

const diffInput = z.object({
  from: z.string().min(1).describe('The History id of the earlier response (the expected side)'),
  to: z.string().min(1).describe('The History id of the later response (the actual side)'),
  ignore: z
    .array(z.string().min(1))
    .default([])
    .describe('Paths to leave out, as the diff reports them (/0/seen); * matches one segment, a leading // any depth'),
});

interface ResponseSide {
  readonly entry: HistoryEntry;
  readonly message: RedactedMessage;
}

function responseOf(history: HistoryFile, id: string): ResponseSide {
  const entry = history.get(id);
  if (entry === undefined) {
    throw new OpsError('history-entry-not-found', `No History entry has the id "${id}"`, { historyId: id });
  }
  const body = entry.response?.envelopeXml;
  if (entry.response === undefined || body === undefined) {
    throw new OpsError('history-no-response', `The History entry "${id}" has no response body to compare`, {
      historyId: id,
    });
  }
  const contentType = entry.response.rawHeaders.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  return { entry, message: redactedMessage(body, contentType) };
}

/** How a redacted message is compared: by its text (the declared content type never decides). */
function formatOf(message: RedactedMessage): SnapshotFormat {
  if (message.kind === 'xml') {
    return 'xml';
  }
  const start = message.text.trimStart();
  return start.startsWith('{') || start.startsWith('[') ? 'json' : 'text';
}

function sideOf(entry: HistoryEntry): DiffSide {
  return {
    id: entry.id,
    at: entry.at,
    item: historyItemOf(entry),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
  };
}

/** The leading changes that fit {@link MAX_DIFF_CHARS} together, and whether any were left out. */
function withinBudget(changes: readonly SnapshotChange[]): { kept: SnapshotChange[]; truncated: boolean } {
  const kept: SnapshotChange[] = [];
  let used = 0;
  for (const change of changes) {
    used += change.path.length + (change.expected?.length ?? 0) + (change.actual?.length ?? 0);
    if (used > MAX_DIFF_CHARS) {
      return { kept, truncated: true };
    }
    kept.push(change);
  }
  return { kept, truncated: false };
}

export const historyDiffOp = defineOp({
  name: 'history_diff',
  title: 'Diff two responses',
  description:
    'Compares the responses of two History entries with the semantic XML or JSON diff the desktop uses, ' +
    'optionally ignoring paths such as timestamps. Both are read through the redaction first, so a password or ' +
    'secret-keyed value reads as <redacted> on both sides and never shows as a change. The changes are cut at ' +
    '256 KiB characters in all (truncated says so). Reads only.',
  input: diffInput,
  async run(value, context): Promise<HistoryDiffResult> {
    const history = await historyOf(context);
    const from = responseOf(history, value.from);
    const to = responseOf(history, value.to);
    const fromFormat = formatOf(from.message);
    // Two kinds of body have no semantic comparison: they are compared as text.
    const format = fromFormat === formatOf(to.message) ? fromFormat : 'text';
    const diff = diffSnapshot(from.message.text, to.message.text, { format, ignore: value.ignore });
    const { kept, truncated } = withinBudget(diff.changes);
    const result: HistoryDiffResult = {
      from: sideOf(from.entry),
      to: sideOf(to.entry),
      format: diff.format,
      changes: kept,
      ignored: diff.ignored,
      ...(diff.error !== undefined ? { error: diff.error } : {}),
      truncated,
    };
    return maskDeep(result, redactUrlsInText) as HistoryDiffResult;
  },
});
