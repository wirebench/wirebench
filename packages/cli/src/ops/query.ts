/**
 * `query` (spec §2): XPath on an XML message, JSONPath on a JSON one, through the engine's
 * time-boxed worker. The document's own prefixes are known to the expression; `namespaces` adds more.
 */
import { collectNamespaces, evaluateWithTimeout } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { keptLength } from './cut.js';
import { OpsError } from './errors.js';
import { exactlyOneSource, loadMessage, SOURCE_MESSAGE, sourceFields } from './sources.js';

/** The most characters one result keeps. */
export const MAX_RESULT_CHARS = 64 * 1024;
/** The most characters all results keep together. */
export const MAX_TOTAL_CHARS = 256 * 1024;

export interface QueryOutput {
  readonly language: 'xpath' | 'jsonpath';
  /**
   * Each result as text: a node serialised, a value as written. One result keeps at most 64 KiB
   * characters and all together at most 256 KiB; longer ones are cut.
   */
  readonly results: readonly string[];
  /** Something was left out: more results than the engine returns (1000), or a result cut at a size cap. */
  readonly truncated: boolean;
}

const input = z
  .object({
    expression: z.string().min(1).describe('An XPath 3.1 expression for XML, or a JSONPath expression for JSON'),
    namespaces: z
      .record(z.string(), z.string())
      .optional()
      .describe("XPath prefixes to namespace URIs, on top of the document's own"),
    ...sourceFields,
  })
  .refine(exactlyOneSource, { message: SOURCE_MESSAGE });

function documentPrefixes(xml: string): Record<string, string> {
  try {
    return collectNamespaces(xml);
  } catch {
    // Not well formed: the failure is reported once the evaluator has run.
    return {};
  }
}

/** Whether the parser reads the message. Only asked once a query failed, to say why. */
function wellFormed(text: string, xml: boolean): boolean {
  try {
    if (xml) {
      collectNamespaces(text);
    } else {
      JSON.parse(text);
    }
    return true;
  } catch {
    return false;
  }
}

/** The results cut to the caps, and whether any cut was made. */
function capped(items: readonly string[]): { readonly results: string[]; readonly cut: boolean } {
  const results: string[] = [];
  let left = MAX_TOTAL_CHARS;
  let cut = false;
  for (const item of items) {
    const keep = keptLength(item, Math.min(MAX_RESULT_CHARS, left));
    if (keep === 0 && item.length > 0) {
      // What is left cannot hold this item's first character: stop rather than add an empty fragment.
      cut = true;
      break;
    }
    if (keep < item.length) {
      cut = true;
    }
    results.push(item.slice(0, keep));
    left -= keep;
    if (left === 0 && results.length < items.length) {
      cut = true;
      break;
    }
  }
  return { results, cut };
}

export const queryOp = defineOp({
  name: 'query',
  title: 'Query a message',
  description:
    'Runs XPath on an XML message or JSONPath on a JSON one and returns the matches as text, each cut at 64 KiB ' +
    'characters and all together at 256 KiB (truncated says so). Reads a History entry, a file or the text ' +
    'itself: pass exactly one of historyId, file, text. A password or secret-keyed value in the message reads as ' +
    '<redacted>. Reads only.',
  input,
  async run(value, context): Promise<QueryOutput> {
    const message = await loadMessage(value, context);
    const xml = message.kind === 'xml';
    const result = xml
      ? await evaluateWithTimeout(
          message.text,
          value.expression,
          { language: 'xpath', namespaces: { ...documentPrefixes(message.text), ...value.namespaces } },
          { kind: 'xml' },
        )
      : await evaluateWithTimeout(message.text, value.expression, { language: 'jsonpath' }, { kind: 'json' });
    if (result.kind === 'error') {
      // A parser's message can quote the text it choked on, so a message that does not parse is not echoed.
      const failure = wellFormed(message.text, xml)
        ? result.message
        : `the message is not well-formed ${xml ? 'XML' : 'JSON'}`;
      throw new OpsError('query-failed', failure, {
        expression: value.expression,
        ...(result.code !== undefined ? { reason: result.code } : {}),
      });
    }
    const { results, cut } = capped(result.kind === 'empty' ? [] : result.items.map((item) => item.text));
    return {
      language: xml ? 'xpath' : 'jsonpath',
      results,
      truncated: cut || (result.kind !== 'empty' && result.truncated),
    };
  },
});
