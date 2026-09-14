/**
 * Persistent, per-project request history: a JSON-Lines file the desktop app keeps outside the
 * project folder (under Electron's `userData`), so history survives even when the project folder
 * itself is deleted, moved, or never saved. Entries are appended already redacted — this module
 * never sees a secret, it only stores and reads back whatever the caller hands it.
 *
 * Pure and `FsLike`-injectable, like the rest of `project/*`: no knowledge of Electron's
 * `userData`, no knowledge of the wire format's redaction rules.
 */

import { ulid } from 'ulidx';
import { nodeFs, readFileIfExists, writeFileAtomic } from './fs.js';
import type { FsLike } from './fs.js';

/** One HTTP header, in author order. */
export interface HistoryHeader {
  readonly name: string;
  readonly value: string;
}

/** The SOAP fault a send resolved to, if any. */
export interface HistoryFault {
  readonly code: string;
  readonly reason: string;
}

/** Why a send failed before a response was ever received (transport error, timeout, abort, ...). */
export interface HistoryError {
  readonly code: string;
  readonly message: string;
}

/**
 * One recorded send. Stored **already redacted** by the caller — this module has no concept of
 * secrets and never inspects `request`/`response` bodies beyond storing and searching them.
 */
export interface HistoryEntry {
  /** ulid, also the entry's sort key (ulids are lexicographically time-ordered). */
  readonly id: string;
  /**
   * Which protocol this send used. Absent in every line written before the REST client, so a
   * missing value reads as `'soap'` ({@link normalizeHistoryEntry}) and no file needs migrating.
   *
   * The response side of the record is deliberately one message. A protocol that answers with
   * several — a gRPC server stream — extends this union with its own shape rather than bending
   * this one, which is why the field exists before there is a second value for it to hold.
   */
  readonly kind?: 'soap' | 'rest';
  /** The HTTP method, for a REST send. A SOAP send is always a POST and does not record one. */
  readonly method?: string;
  /** ISO-8601 timestamp of the send. */
  readonly at: string;
  readonly projectId: string;
  /** The saved request this send came from, if it still existed at send time. */
  readonly requestId?: string;
  /** The saved request's name at send time, or a synthesised label for an ad-hoc/raw resend. */
  readonly requestName: string;
  readonly interfaceName: string;
  readonly operationName: string;
  readonly endpoint: string;
  readonly soapVersion: '1.1' | '1.2' | 'none';
  readonly soapAction?: string;
  /** HTTP status, absent when the send never received a response. */
  readonly status?: number;
  readonly durationMs: number;
  /** True for a 2xx response with no SOAP fault. */
  readonly ok: boolean;
  readonly fault?: HistoryFault;
  readonly request: {
    readonly envelopeXml: string;
    readonly headers: readonly HistoryHeader[];
  };
  readonly response?: {
    readonly envelopeXml?: string;
    readonly rawHeaders: readonly (readonly [string, string])[];
    readonly status: number;
    readonly statusText: string;
  };
  readonly error?: HistoryError;
  readonly sizeBytes: number;
  readonly tags?: readonly string[];
}

/** Options accepted by {@link appendHistory} and {@link openHistory}. */
export interface HistoryOptions {
  readonly fs?: FsLike;
  /** Oldest entries are dropped once the file holds more than this many. Defaults to 1000. */
  readonly cap?: number;
}

/** Filters accepted by {@link HistoryFile.list}. */
export interface HistoryListQuery {
  /** Case-insensitive substring match over name/operation/interface/endpoint/status/fault/tags. */
  readonly query?: string;
  readonly limit?: number;
  /** Only entries strictly older than this id (for paging past a previous page's last row). */
  readonly before?: string;
}

/** A live handle on one project's history file: an in-memory cache backed by the jsonl file. */
export interface HistoryFile {
  /** Appends one entry (serialised, rotated against the configured cap) and updates the cache. */
  append(entry: HistoryEntry): Promise<void>;
  /** Newest-first entries matching `query`, most recent (or most recent before `before`) first. */
  list(query?: HistoryListQuery): HistoryEntry[];
  get(id: string): HistoryEntry | undefined;
  /** Empties the file and the cache. Returns the number of entries that were cleared. */
  clear(): Promise<number>;
  count(): number;
  /** Corrupt lines skipped while loading the file. */
  readonly problems: number;
}

const DEFAULT_CAP = 1000;

/**
 * One entry as callers should see it: a line written before the REST client carried no `kind`,
 * and every such send was SOAP. Applied on read so nothing has to rewrite a `.jsonl` file.
 */
export function normalizeHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return entry.kind === undefined ? { ...entry, kind: 'soap' } : entry;
}

/** Case-insensitive substring test, empty needle always matches. */
function matches(entry: HistoryEntry, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  const lower = needle.toLowerCase();
  const haystack = [
    entry.requestName,
    entry.operationName,
    entry.interfaceName,
    entry.endpoint,
    entry.method ?? '',
    entry.status !== undefined ? String(entry.status) : '',
    entry.fault?.reason ?? '',
    ...(entry.tags ?? []),
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(lower);
}

/** Parses one jsonl line into a `HistoryEntry`, or `undefined` when the line is corrupt/blank. */
function parseLine(line: string): HistoryEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { id?: unknown }).id !== 'string') {
      return undefined;
    }
    return normalizeHistoryEntry(parsed as HistoryEntry);
  } catch {
    return undefined;
  }
}

/** Reads a jsonl file's entries (oldest first, as stored) and the count of corrupt lines. */
async function readAll(fs: FsLike, file: string): Promise<{ entries: HistoryEntry[]; problems: number }> {
  const buffer = await readFileIfExists(fs, file);
  if (buffer === undefined) {
    return { entries: [], problems: 0 };
  }
  const lines = buffer.toString('utf8').split('\n');
  const entries: HistoryEntry[] = [];
  let problems = 0;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = parseLine(line);
    if (entry === undefined) {
      problems += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, problems };
}

/** Serialises entries (oldest first) back to jsonl text. */
function serialise(entries: readonly HistoryEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '');
}

/**
 * Appends one entry to `file`, rotating so at most `cap` (default 1000) entries remain — the
 * oldest are dropped first. Stateless: rereads the whole file first, so prefer {@link openHistory}
 * when appending more than once (it keeps the entries cached in memory).
 */
export async function appendHistory(file: string, entry: HistoryEntry, options: HistoryOptions = {}): Promise<void> {
  const fs = options.fs ?? nodeFs;
  const cap = options.cap ?? DEFAULT_CAP;
  const { entries } = await readAll(fs, file);
  entries.push(entry);
  const capped = entries.length > cap ? entries.slice(entries.length - cap) : entries;
  await writeFileAtomic(fs, file, serialise(capped));
}

/**
 * Opens a live handle on `file`'s history: loads the current entries into memory once, then
 * serves `list`/`get`/`count` from that cache and keeps it (and the file) in sync on `append`/
 * `clear`. Concurrent `append`/`clear` calls on the same handle are serialised.
 */
export async function openHistory(file: string, options: HistoryOptions = {}): Promise<HistoryFile> {
  const fs = options.fs ?? nodeFs;
  const cap = options.cap ?? DEFAULT_CAP;
  const { entries, problems } = await readAll(fs, file);
  // Oldest-first in memory (matches on-disk order); newest-first is only materialised for `list`.
  let cache: HistoryEntry[] = entries;
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    // Swallow rejections in the chain itself so one failed op doesn't wedge the queue for the
    // next; the caller of this specific call still sees the real rejection via `result`.
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    problems,

    append(entry) {
      return enqueue(async () => {
        cache.push(entry);
        if (cache.length > cap) {
          cache = cache.slice(cache.length - cap);
        }
        await writeFileAtomic(fs, file, serialise(cache));
      });
    },

    list(query) {
      const needle = query?.query ?? '';
      const limit = query?.limit ?? Number.POSITIVE_INFINITY;
      const newestFirst = [...cache].reverse();
      let startIndex = 0;
      if (query?.before !== undefined) {
        const cursor = newestFirst.findIndex((e) => e.id === query.before);
        startIndex = cursor === -1 ? newestFirst.length : cursor + 1;
      }
      const filtered = newestFirst.slice(startIndex).filter((entry) => matches(entry, needle));
      return filtered.slice(0, limit);
    },

    get(id) {
      return cache.find((entry) => entry.id === id);
    },

    clear() {
      return enqueue(async () => {
        const cleared = cache.length;
        cache = [];
        await writeFileAtomic(fs, file, '');
        return cleared;
      });
    },

    count() {
      return cache.length;
    },
  };
}

/** Generates a new history entry id (ulid: lexicographically time-ordered, unique). */
export function generateHistoryId(): string {
  return ulid();
}
