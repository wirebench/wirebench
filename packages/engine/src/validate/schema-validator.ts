/**
 * XSD validation of a SOAP message body against the interface's schema set,
 * using libxml2 compiled to WebAssembly (`xmllint-wasm`).
 *
 * The envelope itself is never validated against the XSD — no schema in a
 * WSDL describes `soapenv:Envelope` — so this module extracts each child of
 * `Body` as its own little document and validates that. The extraction keeps
 * the original source offsets: the fragment is padded with as many blank
 * lines as precede it in the envelope, so every line number libxml2 reports
 * is already a line number in the envelope the user is editing.
 *
 * `xmllint-wasm` runs libxml2 inside its own Node worker thread, so a
 * validation never blocks the caller's event loop (measured: a 500 KB body
 * validates in ~50 ms with a worst-case event-loop gap of ~6 ms). No extra
 * worker of our own is needed; a wall-clock timeout guards against a
 * pathological schema instead.
 *
 * Building the libxml2 file set itself — one synthetic file per schema
 * document, the per-namespace glue files, and the `document`/`rpc` wrapper
 * schemas — lives in `schema-file-set.ts`; this module only orchestrates
 * validating one fragment against what that one builds.
 */

import { validateXML } from 'xmllint-wasm';
import { localNameOf, tokenizeXml, buildRangeTree } from '../xml/tolerant-tree.js';
import type { XmlRangeNode } from '../xml/tolerant-tree.js';
import { escapeAttribute } from '../xsd/xml-writer.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import type { SchemaFileSet } from './schema-file-set.js';
import { buildSchemaFileSet, documentWrapper, fileSetLabels, rpcWrapper } from './schema-file-set.js';
import type { ValidationBinding, ValidationProblem } from './types.js';

/** Default wall-clock budget for one validation, in milliseconds. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000;

/** What the schema validator validates against: the compiled set plus the raw documents behind it. */
export interface SchemaValidationTarget {
  readonly schemaSet: SchemaSet;
  readonly bundle: DefinitionBundle;
}

/** Options for {@link validateAgainstSchemaSet}. */
export interface SchemaValidationOptions {
  /** The operation being validated; required for `rpc` style, where no global element declares the body. */
  readonly binding?: ValidationBinding;
  /** Wall-clock budget for the whole validation; defaults to {@link DEFAULT_VALIDATION_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Bundles whose most recent schema validation timed out and is still running in the background,
 * mapped to the still-outstanding `validateXML` call. A new validation for the same bundle
 * refuses to start a second libxml2 instance while one is stuck (minor 4 of the Task 42 fix
 * round): a runaway schema would otherwise spawn one WASM instance per keystroke. The entry is
 * removed as soon as the stale call finally settles, one way or the other.
 */
const staleByBundle = new WeakMap<DefinitionBundle, Promise<unknown>>();

/** The `xmlns`/`xmlns:*` declarations a range node carries, parsed out of its raw attribute text. */
function declarationsOf(node: XmlRangeNode): Map<string, string> {
  const declarations = new Map<string, string>();
  const pattern = /(xmlns(?::[\w.-]+)?)\s*=\s*"([^"]*)"|(xmlns(?::[\w.-]+)?)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(node.rawAttrs)) !== null) {
    const name = match[1] ?? match[3];
    const value = match[2] ?? match[4];
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value);
    }
  }
  return declarations;
}

/** One body child, extracted as a standalone document that keeps the envelope's line numbers. */
interface BodyFragment {
  readonly name: string;
  readonly namespaceUri: string;
  readonly contents: string;
  readonly line: number;
}

/**
 * Extracts every child element of `Body` as its own document. Returns an empty
 * list when the envelope cannot be tokenized (a half-typed document): the
 * structure checks already report that, and guessing here would only produce
 * bogus markers.
 */
function bodyFragments(xml: string): BodyFragment[] {
  const tokens = tokenizeXml(xml);
  const roots = tokens === undefined ? undefined : buildRangeTree(tokens);
  const envelope = roots?.find((node) => localNameOf(node.name) === 'Envelope');
  const body = envelope?.children.find((node) => localNameOf(node.name) === 'Body');
  if (envelope === undefined || body === undefined) {
    return [];
  }

  // Namespace declarations the fragment inherits: envelope first, then Body,
  // so a redeclaration on the inner element wins.
  const inherited = new Map<string, string>([...declarationsOf(envelope), ...declarationsOf(body)]);

  return body.children.map((child) => {
    const own = declarationsOf(child);
    const extra = [...inherited]
      .filter(([name]) => !own.has(name))
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join('');
    const raw = xml.slice(child.start, child.end);
    const insertAt = 1 + child.name.length;
    const fragment = `${raw.slice(0, insertAt)}${extra}${raw.slice(insertAt)}`;
    const line = xml.slice(0, child.start).split('\n').length;
    const prefix = child.name.includes(':') ? child.name.slice(0, child.name.indexOf(':')) : '';
    const namespaceUri =
      (prefix === '' ? inherited.get('xmlns') : inherited.get(`xmlns:${prefix}`)) ??
      own.get(prefix === '' ? 'xmlns' : `xmlns:${prefix}`) ??
      '';
    const declared = own.get(prefix === '' ? 'xmlns' : `xmlns:${prefix}`);
    return {
      name: child.name,
      namespaceUri: declared ?? namespaceUri,
      // Blank-line padding keeps libxml2's line numbers aligned with the envelope.
      contents: `${'\n'.repeat(line - 1)}${fragment}`,
      line,
    };
  });
}

/** Strips libxml2's "Schemas validity error : " prefix from a message, and every synthetic file
 * name the file set might mention (`labels`) with a name the user actually recognizes. */
function cleanMessage(message: string, labels: ReadonlyMap<string, string>): string {
  let cleaned = message.replace(/^Schemas\s+\w+\s+(?:error|warning)\s*:\s*/i, '').trim();
  for (const [fileName, label] of labels) {
    if (cleaned.includes(fileName)) {
      cleaned = cleaned.split(fileName).join(label);
    }
  }
  return cleaned;
}

/** Runs `promise`, resolving to `fallback` when it takes longer than `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          resolve(fallback);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Validates one body fragment against `wrapper`, mapping libxml2's output to problems. */
async function validateFragment(
  fragment: BodyFragment,
  wrapper: string,
  fileSet: SchemaFileSet,
  timeoutMs: number,
  bundle: DefinitionBundle,
): Promise<ValidationProblem[]> {
  const path = `/Envelope/Body/${fragment.name}`;
  const labels = fileSetLabels(fileSet);
  const timedOut: ValidationProblem[] = [
    {
      severity: 'warning',
      code: 'schema-timeout',
      message: `Schema validation of <${fragment.name}> timed out after ${String(timeoutMs)} ms`,
      source: 'schema',
      line: fragment.line,
      path,
    },
  ];

  const stale = staleByBundle.get(bundle);
  if (stale !== undefined) {
    // A previous validation for this interface is still stuck in libxml2; starting another one
    // now would pile a second WASM instance on top of it. Refuse immediately, and let the stale
    // call keep running in the background — see the `.then` below for when it clears.
    return [
      {
        severity: 'warning',
        code: 'schema-timeout',
        message: `Schema validation of <${fragment.name}> was skipped: the interface's previous validation has not finished yet`,
        source: 'schema',
        line: fragment.line,
        path,
      },
    ];
  }

  const call = validateXML({
    xml: [{ fileName: 'body.xml', contents: fragment.contents }],
    schema: [{ fileName: 'wrapper.xsd', contents: wrapper }],
    preload: fileSet.files.map((file) => ({ fileName: file.fileName, contents: file.contents })),
  });

  let result;
  try {
    result = await withTimeout(call, timeoutMs, undefined);
  } catch (cause) {
    // A schema set that does not compile is a problem with the definition, not
    // with the message: report it once, as a warning, with no position.
    return [
      {
        severity: 'warning',
        code: 'schema-unavailable',
        message: `The interface's schemas could not be compiled: ${cause instanceof Error ? cleanMessage(cause.message, labels) : String(cause)}`,
        source: 'schema',
      },
    ];
  }

  if (result === undefined) {
    // Timed out: track the still-running call so a second validation for this interface refuses
    // to start another libxml2 instance until this one settles, one way or the other, and
    // terminate the tracking (not the call itself — libxml2 gives us no handle for that) once
    // it does.
    staleByBundle.set(bundle, call);
    call.then(
      () => {
        if (staleByBundle.get(bundle) === call) {
          staleByBundle.delete(bundle);
        }
      },
      () => {
        if (staleByBundle.get(bundle) === call) {
          staleByBundle.delete(bundle);
        }
      },
    );
    return timedOut;
  }
  if (result.valid) {
    return [];
  }

  return result.errors.flatMap((error) => {
    const message = cleanMessage(error.message, labels);
    const isBody = error.loc?.fileName === 'body.xml';
    if (!isBody) {
      // libxml2 warns when a namespace reachable through two files is imported
      // twice — an artefact of the glue schemas, not a finding about the message.
      if (/Schemas\s+\w+\s+warning\s*:/i.test(error.rawMessage)) {
        return [];
      }
      return {
        severity: 'warning' as const,
        code: 'schema-unavailable',
        message,
        source: 'schema' as const,
      };
    }
    return {
      severity: 'error' as const,
      code: message.includes('No matching global declaration') ? 'schema-unknown-element' : 'schema-invalid',
      message,
      source: 'schema' as const,
      line: error.loc?.lineNumber ?? fragment.line,
      path,
    };
  });
}

/**
 * Validates the `Body` children of a SOAP envelope against an interface's
 * schema set with libxml2.
 *
 * Never throws: a message that cannot be tokenized, an empty body, or a schema
 * set with no components all yield an empty list (the structure checks own
 * those reports). Positions in the returned problems are lines in `xml`.
 *
 * @param xml the whole envelope text
 * @param target the compiled schema set plus the bundle the raw schema documents come from
 * @param options the binding context (required for `rpc` style) and the timeout
 * @returns every schema finding, in body order
 */
export async function validateAgainstSchemaSet(
  xml: string,
  target: SchemaValidationTarget,
  options?: SchemaValidationOptions,
): Promise<readonly ValidationProblem[]> {
  if (target.schemaSet.elements.size === 0 && target.schemaSet.types.size === 0) {
    return [];
  }
  const fragments = bodyFragments(xml);
  if (fragments.length === 0) {
    return [];
  }

  const fileSet = buildSchemaFileSet(target.bundle);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  const binding = options?.binding;
  const problems: ValidationProblem[] = [];

  for (const fragment of fragments) {
    const wrapper =
      binding?.style === 'rpc'
        ? rpcWrapper(fileSet, fragment.namespaceUri, localNameOf(fragment.name), binding)
        : documentWrapper(fileSet);
    problems.push(...(await validateFragment(fragment, wrapper, fileSet, timeoutMs, target.bundle)));
  }
  return problems;
}
