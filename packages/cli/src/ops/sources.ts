/**
 * Where `validate` and `query` read a message (spec §2): a History entry by id, a file, or the text
 * itself. Exactly one.
 *
 * The text comes back already through the engine's pattern redactors (spec §2.2): a WS-Security
 * password element and a secret-keyed JSON value are masked in the message itself, so neither a
 * query result, nor a validation problem quoting a value, nor a boolean XPath probing one can show
 * what a file or an entry holds. The ops therefore validate and query the redacted message.
 */
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openHistory, REDACTED_MARKER, REDACTED_XML_MARKER, redactStructuredBody, redactXml } from '@wirebench/engine';
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
 * The raw redaction marker where it stands as an element's whole content, as text. `redactXml`
 * writes the marker escaped already, but the raw `<redacted>` still turns up inside an element in a
 * History entry: one recorded before the escaped marker, or any element whose text a send's masker
 * replaced. Raw, it leaves the XML not well formed. An element closed right after it by any name but
 * `redacted` cannot be one of the message's own, so it is escaped; an empty element of the message
 * named `redacted` (`<redacted></redacted>`) stays as it is.
 */
const MARKER_AS_CONTENT = new RegExp(`>${REDACTED_MARKER}(</(?!redacted>)(?:[\\w.-]+:)?[\\w.-]+>)`, 'g');

function isFormType(contentType: string | undefined): boolean {
  return (contentType?.split(';')[0] ?? '').trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

/** A message's text through the engine's redactors, and the kind it was redacted as. */
export interface RedactedMessage {
  readonly kind: 'xml' | 'json';
  readonly text: string;
}

/**
 * The message through the engine's redactors, by the kind of its text (see {@link LoadedMessage.kind}).
 * Every op that reads a message goes through here, so no second redaction path exists.
 */
export function redactedMessage(text: string, contentType: string | undefined): RedactedMessage {
  if (text.trimStart().startsWith('<')) {
    const redacted = redactXml(text, { show: false });
    return { kind: 'xml', text: redacted.replaceAll(MARKER_AS_CONTENT, `>${REDACTED_XML_MARKER}$1`) };
  }
  // Read as JSON whatever the declared type. A declared form type adds the form redaction only for a
  // body that is not JSON: the form pass splits on `&` and `=`, which a JSON string may hold.
  const json = redactStructuredBody(text, 'application/json', { show: false });
  return {
    kind: 'json',
    text:
      isFormType(contentType) && !parsesAsJson(text) ? redactStructuredBody(text, contentType, { show: false }) : json,
  };
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function loaded(message: Omit<LoadedMessage, 'kind'>): LoadedMessage {
  return { ...message, ...redactedMessage(message.text, message.contentType) };
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
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

/** The real path of a path that may not exist (then the path itself: nothing there can be a History file). */
async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** The largest file the `file` source reads. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

const HISTORY_REFUSAL = 'History files are read through historyId, not file';

/** Whether a file with this device and inode is one of the History directory's `*.jsonl` files (a hard link included). */
async function isHistoryFile(historyDir: string, dev: number, ino: number): Promise<boolean> {
  let names: string[];
  try {
    names = (await readdir(historyDir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    // No History directory, so no History file.
    return false;
  }
  for (const name of names) {
    try {
      const found = await stat(join(historyDir, name));
      if (found.dev === dev && found.ino === ino) {
        return true;
      }
    } catch {
      // Gone since the listing.
    }
  }
  return false;
}

/** Refuses a file that is not a regular one, is a History file, or is too big. */
async function checkSourceFile(
  path: string,
  info: { isFile(): boolean; readonly dev: number; readonly ino: number; readonly size: number },
  historyDir: string,
): Promise<void> {
  if (!info.isFile()) {
    throw new OpsError('file-not-found', `Cannot read ${path}: not a regular file`, { file: path });
  }
  if (await isHistoryFile(historyDir, info.dev, info.ino)) {
    throw new OpsError('invalid-input', HISTORY_REFUSAL, { file: path });
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new OpsError('invalid-input', 'the file is larger than 16 MiB', { file: path });
  }
}

/**
 * The text of `file`, resolved against the working directory. It reads any path the process can read,
 * but never a History file (those are read through `historyId`, which redacts by entry), and only a
 * regular file of at most 16 MiB. The path is checked through `realpath`, so a symlink into the History
 * directory does not get around it. The real path is stat'ed before it is opened, so a device or a FIFO
 * is never opened at all; the opened handle must then be that same regular file (device and inode), and
 * is checked against the directory's `*.jsonl` files, so neither a hard link nor a swap between the
 * check and the read gets around it.
 */
async function readSourceFile(file: string, context: Pick<OpsContext, 'historyDir'>): Promise<string> {
  const path = resolve(file);
  try {
    const real = await realpath(path);
    if (isInside(await realOrSelf(context.historyDir), real)) {
      throw new OpsError('invalid-input', HISTORY_REFUSAL, { file: path });
    }
    const before = await stat(real);
    await checkSourceFile(path, before, context.historyDir);
    // Non-blocking, so a FIFO swapped in after the stat does not wait for a writer.
    const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (info.dev !== before.dev || info.ino !== before.ino) {
        throw new OpsError('file-not-found', `Cannot read ${path}: it changed while it was being read`, {
          file: path,
        });
      }
      await checkSourceFile(path, info, context.historyDir);
      // A read may return fewer bytes than asked; never past the stat'ed size, which the check bounds.
      const size = Math.min(info.size, MAX_FILE_BYTES);
      const buffer = Buffer.alloc(size);
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await handle.read(buffer, filled, size - filled, filled);
        if (bytesRead === 0) {
          break;
        }
        filled += bytesRead;
      }
      return buffer.toString('utf8', 0, filled);
    } finally {
      await handle.close();
    }
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
