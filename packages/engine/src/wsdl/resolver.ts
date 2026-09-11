import type { Document, Element } from '@xmldom/xmldom';
import { WsdlParseError } from '../errors.js';
import { NS } from '../xml/namespaces.js';
import { getPosition, parseXml } from '../xml/parse.js';
import { childElements, firstChildElement, optionalAttribute } from './dom-utils.js';
import { MAX_IMPORT_DEPTH, MAX_IMPORT_DOCUMENTS, referencePolicyFor } from './ref-policy.js';

/** The root document to resolve, plus an optional pre-fetched body (avoids a redundant fetch of the root). */
export interface DefinitionSource {
  /** Absolute URL (`http(s)://` or `file://`) identifying the root document. */
  readonly location: string;
  /** Pre-fetched root document text, when the caller already has it in hand. */
  readonly text?: string;
}

/** A fetched document's canonical location (post-redirect) and raw content. */
export interface FetchedDocument {
  /** The final absolute location after following any redirects. */
  readonly location: string;
  readonly bytes: Uint8Array;
  readonly text: string;
}

/** Fetches a single document by absolute location, honouring an optional abort signal. */
export type FetchDocument = (location: string, signal?: AbortSignal) => Promise<FetchedDocument>;

/** Options for {@link resolveDefinition}. */
export interface ResolveOptions {
  readonly fetchDocument: FetchDocument;
  readonly signal?: AbortSignal;
}

/** A single document collected while resolving a WSDL/XSD import graph. */
export interface BundledDocument {
  /** The document's canonical (post-redirect) absolute location. */
  readonly location: string;
  /** The absolute location that was requested to obtain this document, prior to any redirect. */
  readonly requestedLocation: string;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly kind: 'wsdl' | 'xsd';
  /** The location of the document whose `import`/`include`/`redefine` referenced this one, if any (absent for the root). */
  readonly importedBy?: string;
  /** This document's `targetNamespace`, or the namespace a chameleon include adopted from its includer. */
  readonly namespace?: string;
  /** For a chameleon include (an `xs:include` target with no `targetNamespace` of its own): the including document's location. */
  readonly chameleonFor?: string;
  readonly document: Document;
}

/** A non-fatal problem encountered while resolving an import graph. */
export interface ResolveProblem {
  readonly code:
    | 'unsupported-redefine'
    | 'fetch-failed'
    | 'unresolved-import'
    | 'not-xml'
    /** A reference the {@link ReferencePolicy} refused; see `wsdl/ref-policy.ts`. */
    | 'import-ref-refused'
    /** The graph hit the depth or document cap; everything resolved so far is still returned. */
    | 'import-limit';
  readonly message: string;
  readonly location: string;
  readonly line?: number;
  readonly column?: number;
}

/** The full set of documents discovered while resolving a WSDL's import graph, plus any problems encountered. */
export interface DefinitionBundle {
  readonly root: BundledDocument;
  /** Root first, then every imported/included/redefined document in discovery order. */
  readonly documents: readonly BundledDocument[];
  readonly problems: readonly ResolveProblem[];
}

/** A pending fetch, queued while walking a document's imports. */
interface ImportJob {
  readonly requestedLocation: string;
  readonly importedBy: string;
  /** How many `import`/`include` hops away from the root document this one is (root is 0). */
  readonly depth: number;
  /** The enclosing schema's namespace, for chameleon-include adoption when the fetched schema has none of its own. */
  readonly chameleonNamespace?: string;
}

/**
 * Queues `ref`, resolved against `base` with the WHATWG `URL` class (which handles both
 * `http(s):` and `file:`).
 *
 * A relative reference cannot be resolved against the pseudo-location of a pasted or dropped
 * document (`inline:wsdl`, `dropped:service.wsdl`) — there is no directory to resolve it
 * against — so that becomes an `unresolved-import` problem carrying the one action that fixes
 * it, rather than an exception that loses the whole import.
 */
function queueRef(
  ref: string,
  base: string,
  importedBy: string,
  depth: number,
  queue: ImportJob[],
  problems: ResolveProblem[],
  chameleonNamespace?: string,
): void {
  let requestedLocation: string;
  try {
    requestedLocation = new URL(ref, base).toString();
  } catch {
    problems.push({
      code: 'unresolved-import',
      message: `Cannot resolve "${ref}" against "${base}". Use Browse… to import a WSDL whose imports live next to it`,
      location: base,
    });
    return;
  }
  queue.push({
    requestedLocation,
    importedBy,
    depth,
    ...(chameleonNamespace !== undefined ? { chameleonNamespace } : {}),
  });
}

/**
 * Builds a {@link BundledDocument} from a fetched document, determining its
 * `kind` from the root element and, for an `xs:schema` root, its effective
 * namespace (its own `targetNamespace`, or the chameleon namespace adopted
 * from its includer).
 *
 * @throws {Error} if the root element is neither a WSDL `definitions` nor an XSD `schema` and `isRoot` is `false`
 *   (the caller turns this into a `not-xml` problem); a root with an unrecognized shape is tagged `kind: 'wsdl'`
 *   so downstream `parseWsdlDocument` raises its own `not-a-wsdl` error.
 */
function buildBundledDocument(
  fetched: FetchedDocument,
  requestedLocation: string,
  importedBy: string | undefined,
  chameleonNamespace: string | undefined,
  isRoot: boolean,
): BundledDocument {
  const document = parseXml(fetched.text, { location: fetched.location });
  const root = document.documentElement;

  let kind: 'wsdl' | 'xsd';
  let namespace: string | undefined;
  let chameleonFor: string | undefined;

  if (root !== null && root.namespaceURI === NS.WSDL && root.localName === 'definitions') {
    kind = 'wsdl';
    namespace = optionalAttribute(root, 'targetNamespace');
  } else if (root !== null && root.namespaceURI === NS.XSD && root.localName === 'schema') {
    kind = 'xsd';
    const ownNamespace = optionalAttribute(root, 'targetNamespace');
    if (ownNamespace !== undefined) {
      namespace = ownNamespace;
    } else if (chameleonNamespace !== undefined) {
      namespace = chameleonNamespace;
      chameleonFor = importedBy;
    }
  } else if (isRoot) {
    // Leave shape validation of the root to parseWsdlDocument (via parseWsdl), which
    // raises a proper 'not-a-wsdl' WsdlParseError with position details.
    kind = 'wsdl';
  } else {
    throw new Error(`Document at "${fetched.location}" is neither a WSDL <definitions> nor an XSD <schema> root`);
  }

  return {
    location: fetched.location,
    requestedLocation,
    bytes: fetched.bytes,
    text: fetched.text,
    kind,
    ...(importedBy !== undefined ? { importedBy } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(chameleonFor !== undefined ? { chameleonFor } : {}),
    document,
  };
}

/** Walks one `xs:schema` element's `xs:import`/`xs:include`/`xs:redefine` children, queuing referenced documents. */
function collectSchemaImports(
  schemaEl: Element,
  baseLocation: string,
  importedBy: string,
  depth: number,
  queue: ImportJob[],
  problems: ResolveProblem[],
): void {
  const ownNamespace = optionalAttribute(schemaEl, 'targetNamespace');

  for (const importEl of childElements(schemaEl, NS.XSD, 'import')) {
    // A namespace-only xs:import (no schemaLocation) carries nothing to fetch: Task 7
    // resolves types across the bundle by namespace instead.
    const schemaLocation = optionalAttribute(importEl, 'schemaLocation');
    if (schemaLocation === undefined) {
      continue;
    }
    queueRef(schemaLocation, baseLocation, importedBy, depth, queue, problems);
  }

  for (const includeEl of childElements(schemaEl, NS.XSD, 'include')) {
    const schemaLocation = optionalAttribute(includeEl, 'schemaLocation');
    if (schemaLocation === undefined) {
      continue;
    }
    queueRef(schemaLocation, baseLocation, importedBy, depth, queue, problems, ownNamespace);
  }

  for (const redefineEl of childElements(schemaEl, NS.XSD, 'redefine')) {
    const schemaLocation = optionalAttribute(redefineEl, 'schemaLocation');
    const pos = getPosition(redefineEl);
    problems.push({
      code: 'unsupported-redefine',
      message: `xs:redefine is not supported${schemaLocation !== undefined ? ` (schemaLocation="${schemaLocation}")` : ''}`,
      location: baseLocation,
      ...(pos !== undefined ? pos : {}),
    });
    if (schemaLocation !== undefined) {
      // Still fetch the referenced document, treating the redefine as a plain include.
      queueRef(schemaLocation, baseLocation, importedBy, depth, queue, problems, ownNamespace);
    }
  }
}

/** Walks a {@link BundledDocument}'s imports/includes/redefines, queuing every referenced document. */
function collectImports(doc: BundledDocument, depth: number, queue: ImportJob[], problems: ResolveProblem[]): void {
  const root = doc.document.documentElement;
  if (root === null) {
    return;
  }

  if (doc.kind === 'wsdl') {
    for (const importEl of childElements(root, NS.WSDL, 'import')) {
      const location = optionalAttribute(importEl, 'location');
      if (location === undefined) {
        continue;
      }
      queueRef(location, doc.location, doc.location, depth, queue, problems);
    }

    const typesEl = firstChildElement(root, NS.WSDL, 'types');
    if (typesEl !== undefined) {
      for (const schemaEl of childElements(typesEl, NS.XSD, 'schema')) {
        collectSchemaImports(schemaEl, doc.location, doc.location, depth, queue, problems);
      }
    }
  } else {
    collectSchemaImports(root, doc.location, doc.location, depth, queue, problems);
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason !== undefined ? signal.reason : new DOMException('Aborted', 'AbortError');
}

// Wrapped in a function (rather than inlining `signal?.aborted === true`) so TypeScript does not
// carry a `false` narrowing of the readonly `aborted` property across loop iterations/awaits.
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw abortError(signal);
  }
}

/**
 * Resolves a WSDL/XSD document's full import graph (`wsdl:import`, `xs:import`,
 * `xs:include`, `xs:redefine`) into a flat {@link DefinitionBundle}, fetching
 * every referenced document exactly once (by canonical, post-redirect
 * location) through the injected `fetchDocument`.
 *
 * Every nested reference is first judged against the root document's world (see
 * `wsdl/ref-policy.ts`): a `file:` root may only reference `file:` documents inside its own
 * folder, an `http(s):` root may only reference `http(s):` documents, and a pasted/dropped
 * root may only reference `http(s):` documents. A refused reference becomes an
 * `import-ref-refused` problem and the import continues with what did resolve — so a WSDL
 * cannot be used to read arbitrary local files. The graph is additionally capped at
 * {@link MAX_IMPORT_DEPTH} levels and {@link MAX_IMPORT_DOCUMENTS} documents (`import-limit`).
 *
 * A failed fetch of an imported/included document is recorded as a
 * `fetch-failed` {@link ResolveProblem} and resolution continues with the
 * rest of the graph; a failed fetch of the root document throws instead,
 * since there is nothing to return without it.
 *
 * @throws {WsdlParseError} with code `fetch-failed` if the root document cannot be fetched
 * @throws if `options.signal` is already aborted, or becomes aborted mid-resolution
 */
export async function resolveDefinition(source: DefinitionSource, options: ResolveOptions): Promise<DefinitionBundle> {
  const { fetchDocument, signal } = options;
  checkAborted(signal);

  const problems: ResolveProblem[] = [];
  const canonicalDocs = new Map<string, BundledDocument>();
  const requestedSeen = new Set<string>([source.location]);

  let rootFetched: FetchedDocument;
  if (source.text !== undefined) {
    rootFetched = { location: source.location, bytes: new TextEncoder().encode(source.text), text: source.text };
  } else {
    try {
      rootFetched = await fetchDocument(source.location, signal);
    } catch (cause) {
      throw new WsdlParseError('fetch-failed', `Failed to fetch root document "${source.location}"`, {
        cause,
        details: { location: source.location },
      });
    }
  }
  requestedSeen.add(rootFetched.location);

  const rootDoc = buildBundledDocument(rootFetched, source.location, undefined, undefined, true);
  canonicalDocs.set(rootFetched.location, rootDoc);
  const documents: BundledDocument[] = [rootDoc];

  // Every nested reference is judged against the *root* document's world; see `ref-policy.ts`.
  const policy = referencePolicyFor(rootFetched.location);

  const queue: ImportJob[] = [];
  collectImports(rootDoc, 1, queue, problems);

  let limitReported = false;
  while (queue.length > 0) {
    const job = queue.shift();
    /* v8 ignore next 3 -- queue.length > 0 guarantees a defined element */
    if (job === undefined) {
      continue;
    }
    if (requestedSeen.has(job.requestedLocation)) {
      continue;
    }
    requestedSeen.add(job.requestedLocation);

    if (job.depth > MAX_IMPORT_DEPTH || documents.length >= MAX_IMPORT_DOCUMENTS) {
      // One problem for the whole runaway graph: a cap hit usually trips on hundreds of
      // references at once, and a problems list that long tells the user nothing extra.
      if (!limitReported) {
        limitReported = true;
        problems.push({
          code: 'import-limit',
          message:
            job.depth > MAX_IMPORT_DEPTH
              ? `Import graph deeper than ${String(MAX_IMPORT_DEPTH)} levels; the rest was not fetched`
              : `Import graph larger than ${String(MAX_IMPORT_DOCUMENTS)} documents; the rest was not fetched`,
          location: job.importedBy,
        });
      }
      continue;
    }

    const refused = await policy.allows(job.requestedLocation);
    if (refused !== undefined) {
      problems.push({
        code: 'import-ref-refused',
        message: `Refused to fetch "${job.requestedLocation}": ${refused.reason}`,
        location: job.importedBy,
      });
      continue;
    }

    checkAborted(signal);

    let fetched: FetchedDocument;
    try {
      fetched = await fetchDocument(job.requestedLocation, signal);
    } catch (cause) {
      problems.push({
        code: 'fetch-failed',
        message: `Failed to fetch "${job.requestedLocation}": ${cause instanceof Error ? cause.message : String(cause)}`,
        location: job.requestedLocation,
      });
      continue;
    }
    requestedSeen.add(fetched.location);

    // A redirect may converge onto a location already fetched via a different request.
    if (canonicalDocs.has(fetched.location)) {
      continue;
    }

    let bundled: BundledDocument;
    try {
      bundled = buildBundledDocument(fetched, job.requestedLocation, job.importedBy, job.chameleonNamespace, false);
    } catch (cause) {
      problems.push({
        code: 'not-xml',
        message: cause instanceof Error ? cause.message : String(cause),
        location: fetched.location,
      });
      continue;
    }

    canonicalDocs.set(fetched.location, bundled);
    documents.push(bundled);
    collectImports(bundled, job.depth + 1, queue, problems);
  }

  return { root: rootDoc, documents, problems };
}
