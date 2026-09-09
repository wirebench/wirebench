import { DOMParser } from '@xmldom/xmldom';
import type { Document, Node } from '@xmldom/xmldom';
import { WirebenchError } from '../errors.js';

/** Options accepted by {@link parseXml}. */
export interface ParseXmlOptions {
  /** A human-readable origin for the document (file path or URL), included in error details. */
  readonly location?: string;
}

/**
 * xmldom decorates parsed nodes with non-standard `lineNumber`/`columnNumber`
 * properties when the parser is constructed with `locator: true` (the
 * default). These are not part of the standard DOM `Node` interface, so we
 * describe them with a small structural interface instead of using `any`.
 */
interface LocatedNode {
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

/** The locator xmldom passes to `DOMHandler`, exposed via the `onError` context argument. */
interface XmldomLocator {
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

/** The `context` argument xmldom's `onError` callback receives: a `DOMHandler` instance. */
interface XmldomErrorContext {
  readonly locator?: XmldomLocator;
}

/** A single warning/error/fatalError reported by xmldom while parsing. */
interface ParseMessage {
  readonly level: string;
  readonly message: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
}

/**
 * Parses an XML string into a DOM `Document` using `@xmldom/xmldom`.
 *
 * Unlike xmldom's own defaults, this never writes to the console: every
 * parse error (warning, error, or fatal error) is collected and surfaced as
 * a single thrown {@link WirebenchError} with code `xml-parse-error`.
 *
 * @param text the XML source to parse
 * @param options.location a human-readable origin (file path/URL) included in the thrown error's details
 * @returns the parsed `Document`
 * @throws {WirebenchError} with code `xml-parse-error` if the document is malformed
 */
export function parseXml(text: string, options?: ParseXmlOptions): Document {
  const messages: ParseMessage[] = [];

  const parser = new DOMParser({
    locator: true,
    onError: (level, message, context) => {
      const locator = (context as XmldomErrorContext | undefined)?.locator;
      messages.push({ level, message, line: locator?.lineNumber, column: locator?.columnNumber });
      // Treat every reported problem (not just fatalError) as fatal: throwing here
      // both stops the parser immediately and prevents xmldom's default console output.
      throw new Error(message);
    },
  });

  try {
    return parser.parseFromString(text, 'application/xml');
  } catch (cause) {
    // `onError` above always pushes a message before throwing, so `last` is
    // populated whenever this catch runs via that path. The fallback only
    // guards against a hypothetical error from `parseFromString` itself.
    const last = messages[messages.length - 1];
    /* v8 ignore next */
    const fallbackMessage = last?.message ?? 'Failed to parse XML';
    throw new WirebenchError('xml-parse-error', fallbackMessage, {
      cause,
      details: {
        location: options?.location,
        line: last?.line,
        column: last?.column,
        message: fallbackMessage,
      },
    });
  }
}

/**
 * Reads the source position xmldom recorded for `node` when it was parsed
 * with `locator: true`. Returns `undefined` for nodes without position data
 * (e.g. nodes created programmatically rather than parsed).
 */
export function getPosition(node: Node): { line: number; column: number } | undefined {
  const located = node as unknown as LocatedNode;
  if (located.lineNumber === undefined || located.columnNumber === undefined) {
    return undefined;
  }
  return { line: located.lineNumber, column: located.columnNumber };
}
