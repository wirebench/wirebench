/**
 * Where `validate` and `query` read a message (spec §2): a History entry by id, a file, or the text
 * itself. Exactly one.
 *
 * The text comes back already through the engine's pattern redactors (spec §2.2): a WS-Security
 * password element and a secret-keyed JSON value are masked in the message itself, so neither a
 * query result, nor a validation problem quoting a value, nor a boolean XPath probing one can show
 * what a file or an entry holds. The ops therefore validate and query the redacted message.
 */
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { openHistory, REDACTED_MARKER, redactStructuredBody, redactXml } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { z } from 'zod';
import type { OpsContext } from './context.js';
import { OpsError } from './errors.js';
import { historyFileFor } from './paths.js';
import { openProject } from './project.js';

export const sourceFields = {
  historyId: z.string().min(1).optional().describe('A History entry id, as history_list or send returns it'),
  file: z
    .string()
    .min(1)
    .optional()
    .describe('A file holding the message, read from the working directory of the wirebench process'),
  text: z.string().optional().describe('The message itself'),
  direction: z
    .enum(['request', 'response'])
    .default('response')
    .describe('Which side of a History entry to read, and which side of the contract to check (default response)'),
};

export const SOURCE_MESSAGE = 'pass exactly one of historyId, file and text';

export function exactlyOneSource(value: {
  readonly historyId?: string | undefined;
  readonly file?: string | undefined;
  readonly text?: string | undefined;
}): boolean {
  return [value.historyId, value.file, value.text].filter((source) => source !== undefined).length === 1;
}

export interface LoadedMessage {
  /** Redacted: see the module comment. */
  readonly text: string;
  /**
   * What the text is, decided once here from the text itself (a leading `<` is XML, anything else is
   * read as JSON) and never from a declared content type, which a server or a file name can get wrong.
   * The redaction below and the ops after it all go by this.
   */
  readonly kind: 'xml' | 'json';
  /** The content type the message was declared with, when it had one. */
  readonly contentType?: string;
  readonly direction: 'request' | 'response';
  /** Set when the message came from History. */
  readonly entry?: HistoryEntry;
}

function headerValue(pairs: readonly (readonly [string, string])[], name: string): string | undefined {
  return pairs.find(([key]) => key.toLowerCase() === name)?.[1];
}

/**
 * The redactor's own marker where it stands as a whole `Password` element's content, as text. The
 * marker is `<redacted>`, which inside an element leaves the XML not well formed (a History entry a
 * send stored holds it too). Only that place is escaped: an element of the message that happens to be
 * named `redacted` stays as it is.
 */
const MARKER_AS_CONTENT = new RegExp(`>${REDACTED_MARKER}(</(?:[\\w-]+:)?Password>)`, 'gi');

function isFormType(contentType: string | undefined): boolean {
  return (contentType?.split(';')[0] ?? '').trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

/** The message through the engine's redactors, by the kind of its text (see {@link LoadedMessage.kind}). */
function loaded(message: Omit<LoadedMessage, 'kind'>): LoadedMessage {
  if (message.text.trimStart().startsWith('<')) {
    const redacted = redactXml(message.text, { show: false });
    return { ...message, kind: 'xml', text: redacted.replaceAll(MARKER_AS_CONTENT, '>&lt;redacted&gt;$1') };
  }
  // A declared form type keeps the form redaction; anything else is read as JSON.
  const type = isFormType(message.contentType) ? message.contentType : 'application/json';
  return { ...message, kind: 'json', text: redactStructuredBody(message.text, type, { show: false }) };
}

async function fromHistory(
  id: string,
  direction: 'request' | 'response',
  context: Pick<OpsContext, 'projectDir' | 'historyDir' | 'warn'>,
): Promise<LoadedMessage> {
  const { project } = await openProject(context);
  const history = await openHistory(historyFileFor(context.historyDir, project.id));
  const entry = history.get(id);
  if (entry === undefined) {
    throw new OpsError('history-entry-not-found', `No History entry has the id "${id}"`, { historyId: id });
  }
  if (direction === 'request') {
    const contentType = entry.request.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value;
    return loaded({
      text: entry.request.envelopeXml,
      direction,
      entry,
      ...(contentType !== undefined ? { contentType } : {}),
    });
  }
  const text = entry.response?.envelopeXml;
  if (entry.response === undefined || text === undefined) {
    throw new OpsError('history-no-response', `The History entry "${id}" has no response body`, { historyId: id });
  }
  const contentType = headerValue(entry.response.rawHeaders, 'content-type');
  return loaded({ text, direction, entry, ...(contentType !== undefined ? { contentType } : {}) });
}

/** Whether `path` is `directory` or lies inside it. */
function isInside(directory: string, path: string): boolean {
  const from = relative(directory, path);
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

/** The real path of a path that may not exist (then the path itself: nothing there can be a History file). */
async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The text of `file`, resolved against the working directory. It reads any path the process can read,
 * but never a History file: those are read through `historyId`, which redacts by entry. Both sides go
 * through `realpath`, so a symlink into the History directory does not get around this.
 */
async function readSourceFile(file: string, context: Pick<OpsContext, 'historyDir'>): Promise<string> {
  const path = resolve(file);
  try {
    const real = await realpath(path);
    if (isInside(await realOrSelf(context.historyDir), real)) {
      throw new OpsError('invalid-input', 'History files are read through historyId, not file', { file: path });
    }
    return await readFile(real, 'utf8');
  } catch (error) {
    if (error instanceof OpsError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new OpsError(
      'file-not-found',
      code === 'ENOENT' ? `No file at ${path}` : `Cannot read ${path}: ${code ?? 'read failed'}`,
      { file: path },
    );
  }
}

/**
 * The `file` source resolves against the process's working directory and reads any path the process
 * can read: it is not confined to the project (History files excepted, see {@link readSourceFile}).
 *
 * @throws OpsError `history-entry-not-found`, `history-no-response`, `file-not-found`, `invalid-input`
 */
export async function loadMessage(
  value: {
    readonly historyId?: string | undefined;
    readonly file?: string | undefined;
    readonly text?: string | undefined;
    readonly direction: 'request' | 'response';
  },
  context: Pick<OpsContext, 'projectDir' | 'historyDir' | 'warn'>,
): Promise<LoadedMessage> {
  if (value.historyId !== undefined) {
    return fromHistory(value.historyId, value.direction, context);
  }
  if (value.file !== undefined) {
    return loaded({ text: await readSourceFile(value.file, context), direction: value.direction });
  }
  return loaded({ text: value.text ?? '', direction: value.direction });
}
