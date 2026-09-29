// packages/cli/src/ops/query.ts
/**
 * `query` (spec §2): XPath on an XML message, JSONPath on a JSON one, through the engine's
 * time-boxed worker. The document's own prefixes are known to the expression; `namespaces` adds more.
 */
import { collectNamespaces, evaluateWithTimeout } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { OpsError } from './errors.js';
import { exactlyOneSource, loadMessage, SOURCE_MESSAGE, sourceFields } from './sources.js';

export interface QueryOutput {
  readonly language: 'xpath' | 'jsonpath';
  /** Each result as text: a node serialised, a value as written. */
  readonly results: readonly string[];
  /** More results than the engine returns (1000) matched. */
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
    // Not well formed: the evaluator reports that itself, with a better message.
    return {};
  }
}

export const queryOp = defineOp({
  name: 'query',
  title: 'Query a message',
  description:
    'Runs XPath on an XML message or JSONPath on a JSON one and returns the matches as text. Reads a History ' +
    'entry, a file or the text itself. Reads only.',
  input,
  async run(value, context): Promise<QueryOutput> {
    const message = await loadMessage(value, context);
    const xml = message.text.trimStart().startsWith('<');
    const result = xml
      ? await evaluateWithTimeout(
          message.text,
          value.expression,
          { language: 'xpath', namespaces: { ...documentPrefixes(message.text), ...value.namespaces } },
          { kind: 'xml' },
        )
      : await evaluateWithTimeout(message.text, value.expression, { language: 'jsonpath' }, { kind: 'json' });
    if (result.kind === 'error') {
      throw new OpsError('query-failed', result.message, {
        expression: value.expression,
        ...(result.code !== undefined ? { reason: result.code } : {}),
      });
    }
    return {
      language: xml ? 'xpath' : 'jsonpath',
      results: result.kind === 'empty' ? [] : result.items.map((item) => item.text),
      truncated: result.kind !== 'empty' && result.truncated,
    };
  },
});
