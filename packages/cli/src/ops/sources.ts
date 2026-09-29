/**
 * Where `validate` and `query` read a message (spec §2): a History entry by id, a file, or the text
 * itself. Exactly one.
 *
 * The text comes back already through the engine's pattern redactors (spec §2.2): a WS-Security
 * password element and a secret-keyed JSON value are masked in the message itself, so neither a
 * query result, nor a validation problem quoting a value, nor a boolean XPath probing one can show
 * what a file or an entry holds. The ops therefore validate and query the redacted message.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openHistory, REDACTED_MARKER } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { z } from 'zod';
import type { OpsContext } from './context.js';
import { OpsError } from './errors.js';
import { historyFileFor } from './paths.js';
import { openProject } from './project.js';
import { isXmlBody, redactBody } from './redact.js';

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
  readonly contentType?: string;
  readonly direction: 'request' | 'response';
  /** Set when the message came from History. */
  readonly entry?: HistoryEntry;
}

function escapeXml(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function headerValue(pairs: readonly (readonly [string, string])[], name: string): string | undefined {
  return pairs.find(([key]) => key.toLowerCase() === name)?.[1];
}

/** The content type the redactors go by: the message's own, else JSON when the text looks like it. */
function redactionType(text: string, contentType: string | undefined): string | undefined {
  if (contentType !== undefined) {
    return contentType;
  }
  return /^\s*[[{]/.test(text) ? 'application/json' : undefined;
}

/**
 * The message through the engine's redactors. The XML marker is `<redacted>`, a tag inside an element
 * and so no longer well-formed (a History entry stored by a send holds it too), so in XML it is
 * escaped to text: the parsers below then read a password element whose text is the marker.
 */
function loaded(message: LoadedMessage): LoadedMessage {
  const type = redactionType(message.text, message.contentType);
  const redacted = redactBody(message.text, type);
  return {
    ...message,
    text: isXmlBody(redacted, type) ? redacted.replaceAll(REDACTED_MARKER, escapeXml(REDACTED_MARKER)) : redacted,
  };
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

/**
 * The `file` source resolves against the process's working directory and reads any path the process
 * can read: it is not confined to the project.
 *
 * @throws OpsError `history-entry-not-found`, `history-no-response`, `file-not-found`
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
    const path = resolve(value.file);
    try {
      return loaded({ text: await readFile(path, 'utf8'), direction: value.direction });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OpsError('file-not-found', `No file at ${path}`, { file: path });
      }
      throw error;
    }
  }
  return loaded({ text: value.text ?? '', direction: value.direction });
}
