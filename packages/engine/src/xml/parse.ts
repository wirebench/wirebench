import { DOMParser } from '@xmldom/xmldom';
import type { Document, Node } from '@xmldom/xmldom';
import { WirebenchError } from '../errors.js';

/** Options accepted by {@link parseXml} and {@link parseXmlDetailed}. */
export interface ParseXmlOptions {
  /** A human-readable origin for the document (file path or URL), included in error details. */
  readonly location?: string;
}

/**
 * A non-fatal problem xmldom reported while parsing (a `warning` or `error`
 * level `onError` call). The document was still produced despite this
 * problem; only `fatalError` aborts parsing entirely (see {@link parseXmlDetailed}).
 */
export interface XmlProblem {
  readonly level: 'warning' | 'error';
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
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

/** The result of classifying a single xmldom `onError` callback invocation. */
export type ParseEventClassification =
  { readonly fatal: true } | { readonly fatal: false; readonly level: 'warning' | 'error' };

/**
 * Determines whether a raw xmldom `onError` level is fatal. Only xmldom's
 * `fatalError` level aborts parsing; `warning` and `error` are reported
 * problems that xmldom still recovers from, producing a `Document`.
 *
 * Exported as a pure function so the level-dispatch logic can be unit-tested
 * directly even if no non-fatal xmldom input is available in a given
 * environment.
 *
 * @param level the raw level string xmldom passed to `onError`
 * @param message the message xmldom passed to `onError` (unused by the classification itself;
 *   accepted so the exported signature matches the full `onError` payload callers reason about)
 */
export function classifyParseEvent(level: string, message: string): ParseEventClassification {
  void message;
  if (level === 'fatalError') {
    return { fatal: true };
  }
  // xmldom only ever reports 'warning', 'error', or 'fatalError'; treat anything
  // else defensively as a non-fatal 'error' rather than silently dropping it.
  return { fatal: false, level: level === 'warning' ? 'warning' : 'error' };
}

/**
 * Parses an XML string into a DOM `Document` using `@xmldom/xmldom`, and
 * collects every warning/error xmldom reports along the way (without
 * printing anything to the console).
 *
 * Only a `fatalError` from xmldom aborts parsing and results in a thrown
 * {@link WirebenchError}; lesser `warning`/`error` levels are collected into
 * `problems` and the resulting `Document` (which xmldom still produces
 * despite them) is returned.
 *
 * @param text the XML source to parse
 * @param options.location a human-readable origin (file path/URL) included in the thrown error's details and in each collected problem
 * @returns the parsed `Document` plus any non-fatal problems xmldom reported
 * @throws {WirebenchError} with code `xml-parse-error` if xmldom reports a `fatalError`
 */
export function parseXmlDetailed(
  text: string,
  options?: ParseXmlOptions,
): { document: Document; problems: readonly XmlProblem[] } {
  const problems: XmlProblem[] = [];
  let fatal: { message: string; line: number | undefined; column: number | undefined } | undefined;

  const parser = new DOMParser({
    locator: true,
    onError: (level, message, context) => {
      const locator = (context as XmldomErrorContext | undefined)?.locator;
      const classification = classifyParseEvent(level, message);
      if (classification.fatal) {
        fatal = { message, line: locator?.lineNumber, column: locator?.columnNumber };
        // Throwing here both stops the parser immediately and prevents xmldom's
        // default console output for this (fatal) event.
        throw new Error(message);
      }
      problems.push({
        level: classification.level,
        message,
        ...(locator?.lineNumber !== undefined ? { line: locator.lineNumber } : {}),
        ...(locator?.columnNumber !== undefined ? { column: locator.columnNumber } : {}),
        ...(options?.location !== undefined ? { location: options.location } : {}),
      });
    },
  });

  try {
    const document = parser.parseFromString(text, 'application/xml');
    return { document, problems };
  } catch (cause) {
    // `onError` above only throws for a fatal event, which always populates
    // `fatal` first. The fallback only guards against a hypothetical error
    // thrown by `parseFromString` itself outside of `onError`.
    /* v8 ignore next */
    const fallbackMessage = fatal?.message ?? 'Failed to parse XML';
    throw new WirebenchError('xml-parse-error', fallbackMessage, {
      cause,
      details: {
        location: options?.location,
        line: fatal?.line,
        column: fatal?.column,
        message: fallbackMessage,
      },
    });
  }
}

/**
 * Parses an XML string into a DOM `Document` using `@xmldom/xmldom`.
 *
 * Thin wrapper over {@link parseXmlDetailed} that discards non-fatal
 * `problems` and returns only the `Document`. Never writes to the console.
 *
 * @param text the XML source to parse
 * @param options.location a human-readable origin (file path/URL) included in the thrown error's details
 * @returns the parsed `Document`
 * @throws {WirebenchError} with code `xml-parse-error` if xmldom reports a `fatalError`
 */
export function parseXml(text: string, options?: ParseXmlOptions): Document {
  return parseXmlDetailed(text, options).document;
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
