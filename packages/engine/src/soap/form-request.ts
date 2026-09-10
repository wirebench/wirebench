/**
 * Bridges the Form view to a whole SOAP envelope: finds the `soapenv:Body`
 * child element(s) a request's operation is built from, models them with the
 * schema-driven form model, and reports the exact text range the renderer must
 * splice a re-serialised fragment over. Everything outside that range — the
 * envelope, its namespace declarations, any headers — is never touched.
 */

import { NS } from '../xml/namespaces.js';
import { findBinding, findMessage, findPortType } from '../wsdl/model.js';
import type { Part } from '../wsdl/model.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import type { BuildFormOptions, FormNode, TextRange } from '../xsd/form-model.js';
import { buildForm, buildFormForType } from '../xsd/form-model.js';
import type { ScannedElement } from '../xsd/xml-scan.js';
import { scanXml } from '../xsd/xml-scan.js';
import type { OperationRef, RequestBuildInput } from './request-builder.js';

/** What {@link buildRequestForm} returns. */
export interface RequestForm {
  /** The form tree for the Body's content. */
  readonly root: FormNode;
  /** The range of the Body's element children in the envelope text, for splicing. */
  readonly bodyRange: TextRange;
  /** Everything that could not be modelled; the view falls back to "Edit in XML" for those parts. */
  readonly problems: readonly string[];
}

const ENVELOPE_NAMESPACES = new Set<string>([NS.SOAP11_ENV, NS.SOAP12_ENV]);

/** Depth-first search for the `soapenv:Body` element, whichever SOAP version declares it. */
function findBody(elements: readonly ScannedElement[]): ScannedElement | undefined {
  for (const element of elements) {
    if (element.localName === 'Body' && ENVELOPE_NAMESPACES.has(element.namespaceUri)) {
      return element;
    }
    const nested = findBody(element.children);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

/**
 * Every `xmlns:prefix="uri"` declared anywhere in the envelope. A body fragment
 * sliced out of it carries none of its own (the request builder hoists them all
 * onto `soapenv:Envelope`), so the form model needs both directions: `byUri` to
 * name a new element, `byPrefix` to resolve the ones already written.
 */
function namespacesInScope(text: string): { byUri: Record<string, string>; byPrefix: Record<string, string> } {
  const byUri: Record<string, string> = {};
  const byPrefix: Record<string, string> = {};
  const re = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [, prefix, uri] = match;
    if (prefix === undefined || uri === undefined) {
      continue;
    }
    if (byUri[uri] === undefined) {
      byUri[uri] = prefix;
    }
    if (byPrefix[prefix] === undefined) {
      byPrefix[prefix] = uri;
    }
  }
  return { byUri, byPrefix };
}

/** The abstract operation's input message parts, or an empty list when anything is missing. */
function inputParts(input: RequestBuildInput, op: OperationRef, problems: string[]): readonly Part[] {
  const binding = findBinding(input.definition, op.bindingName);
  if (binding === undefined) {
    problems.push(`No binding named ${qnameToString(op.bindingName)}`);
    return [];
  }
  const portType = findPortType(input.definition, binding.type);
  const operation = portType?.operations.find((candidate) => candidate.name === op.operationName);
  const messageRef = operation?.input;
  if (messageRef === undefined) {
    problems.push(`Operation "${op.operationName}" declares no input message`);
    return [];
  }
  const message = findMessage(input.definition, messageRef.message);
  if (message === undefined) {
    problems.push(`Unknown message ${qnameToString(messageRef.message)}`);
    return [];
  }
  return message.parts;
}

/** True when the binding operation is rpc-style, so the Body child is a wrapper, not a schema element. */
function isRpc(input: RequestBuildInput, op: OperationRef): boolean {
  const binding = findBinding(input.definition, op.bindingName);
  if (binding === undefined) {
    return false;
  }
  const bindingOperation = binding.operations.find((candidate) => candidate.name === op.operationName);
  return (bindingOperation?.style ?? binding.style) === 'rpc';
}

/** The form for one document/literal body child: its own global element declaration. */
function documentChildForm(
  input: RequestBuildInput,
  child: ScannedElement,
  envelopeXml: string,
  options: BuildFormOptions,
): FormNode {
  const name: QName = { namespaceUri: child.namespaceUri, localName: child.localName };
  // The fragment is sliced out of the envelope, so its own ranges start at 0;
  // `offset` puts every reported `valueRange` back into envelope coordinates,
  // which is what the renderer splices against.
  return buildForm(input.schemaSet, name, envelopeXml.slice(child.range.start, child.range.end), {
    ...options,
    offset: child.range.start,
  });
}

/**
 * Builds the rpc wrapper's form: the wrapper element itself is not declared in
 * any schema, so it is modelled as a group whose children come from the message
 * parts (each part naming a *type*, per WSDL 1.1 rpc rules).
 */
/** Wraps a wrapper child no message part claims, keeping its text verbatim — same treatment
 * `form-model.ts` gives an unclaimed particle child, so a structural edit never drops it. */
function rawWrapperChild(envelopeXml: string, source: ScannedElement, id: string): FormNode {
  return {
    id,
    kind: 'any',
    name: { namespaceUri: source.namespaceUri, localName: source.localName },
    label: source.name,
    required: false,
    occurs: { min: 0, max: 'unbounded' },
    present: true,
    raw: envelopeXml.slice(source.range.start, source.range.end),
    children: [],
  };
}

function rpcWrapperForm(
  input: RequestBuildInput,
  wrapper: ScannedElement,
  parts: readonly Part[],
  envelopeXml: string,
  options: BuildFormOptions,
  problems: string[],
): FormNode {
  const children: FormNode[] = [];
  const used = wrapper.children.map(() => false);
  for (const [index, part] of parts.entries()) {
    const accessorIndex = wrapper.children.findIndex((candidate, i) => !used[i] && candidate.localName === part.name);
    const accessor = accessorIndex === -1 ? undefined : wrapper.children[accessorIndex];
    if (accessorIndex !== -1) {
      used[accessorIndex] = true;
    }
    const accessorXml =
      accessor === undefined ? undefined : envelopeXml.slice(accessor.range.start, accessor.range.end);
    const accessorOptions: BuildFormOptions = { ...options, offset: accessor?.range.start ?? 0 };
    const name: QName = { namespaceUri: '', localName: part.name };
    if (part.type !== undefined) {
      children.push(
        reroot(buildFormForType(input.schemaSet, name, part.type, accessorXml, accessorOptions), `r/${index}`),
      );
      continue;
    }
    if (part.element !== undefined) {
      children.push(reroot(buildForm(input.schemaSet, part.element, accessorXml, accessorOptions), `r/${index}`));
      continue;
    }
    problems.push(`Part "${part.name}" declares neither an element nor a type`);
  }
  // Elements standing in the wrapper that no message part claims must survive a structural
  // edit verbatim — the same "nothing in the source is dropped" invariant `form-model.ts`
  // upholds for particle children.
  for (const [index, leftover] of wrapper.children.entries()) {
    if (!used[index]) {
      children.push(rawWrapperChild(envelopeXml, leftover, `r/~${index}`));
    }
  }
  return {
    id: 'r',
    kind: 'group',
    name: { namespaceUri: wrapper.namespaceUri, localName: wrapper.localName },
    label: wrapper.name,
    required: true,
    occurs: { min: 1, max: 1 },
    present: true,
    extraAttributes: wrapper.attributes.map((attribute) => ({ name: attribute.name, value: attribute.value })),
    children,
  };
}

/** Rewrites a subtree's ids so several independently built forms can share one root. */
function reroot(node: FormNode, id: string): FormNode {
  return {
    ...node,
    id,
    children: node.children.map((child, i) => reroot(child, `${id}/${i}`)),
    ...(node.repeat !== undefined
      ? {
          repeat: {
            ...node.repeat,
            instances: node.repeat.instances.map((instance, i) => reroot(instance, `${id}#${i}`)),
            template: reroot(node.repeat.template, `${id}#t`),
          },
        }
      : {}),
  };
}

/** An empty form for an envelope whose Body could not be modelled at all. */
function emptyForm(label: string): FormNode {
  return {
    id: 'r',
    kind: 'any',
    name: { namespaceUri: '', localName: label },
    label,
    required: false,
    occurs: { min: 0, max: 1 },
    present: false,
    children: [],
  };
}

/**
 * Models the Body of `envelopeXml` for one binding operation.
 *
 * Document/literal envelopes with exactly one Body child model that element
 * directly; several body parts are gathered under a synthetic group root whose
 * children each serialise on their own. An rpc wrapper is itself the root.
 *
 * Never throws: an unresolvable operation or an unparsable envelope yields an
 * empty form and a problem, so the view can fall back to the XML editor.
 *
 * @param input the parsed WSDL definition and its compiled schema set
 * @param op which operation of which binding the request belongs to
 * @param envelopeXml the request's current envelope text — the single source of truth
 * @param options depth cut-off and sample-value knobs passed through to `buildForm`
 */
export function buildRequestForm(
  input: RequestBuildInput,
  op: OperationRef,
  envelopeXml: string,
  options?: BuildFormOptions,
): RequestForm {
  const problems: string[] = [];
  const scanned = scanXml(envelopeXml);
  problems.push(...scanned.problems);
  const body = findBody(scanned.elements);
  if (body === undefined) {
    problems.push('This envelope has no soapenv:Body element');
    return { root: emptyForm('Body'), bodyRange: { start: 0, end: 0 }, problems };
  }
  const children = body.children;
  const bodyRange: TextRange =
    children.length === 0
      ? { start: body.range.end, end: body.range.end }
      : {
          start: (children[0] as ScannedElement).range.start,
          end: (children[children.length - 1] as ScannedElement).range.end,
        };
  const scope = namespacesInScope(envelopeXml);
  const buildOptions: BuildFormOptions = { ...options, prefixes: scope.byUri, inScope: scope.byPrefix };

  if (children.length === 0) {
    problems.push('This envelope has an empty Body');
    return { root: emptyForm('Body'), bodyRange, problems };
  }

  if (isRpc(input, op)) {
    const wrapper = children[0] as ScannedElement;
    const parts = inputParts(input, op, problems);
    return { root: rpcWrapperForm(input, wrapper, parts, envelopeXml, buildOptions, problems), bodyRange, problems };
  }

  if (children.length === 1) {
    return {
      root: documentChildForm(input, children[0] as ScannedElement, envelopeXml, buildOptions),
      bodyRange,
      problems,
    };
  }

  // Several body parts: a synthetic root that owns them, so one `applyForm`
  // re-renders the whole Body content in one splice.
  return {
    root: {
      id: 'r',
      kind: 'group',
      name: { namespaceUri: '', localName: 'Body' },
      // An empty label makes `applyForm` splice the children out without a tag of its own.
      label: '',
      required: true,
      occurs: { min: 1, max: 1 },
      present: true,
      children: children.map((child, index) =>
        reroot(documentChildForm(input, child, envelopeXml, buildOptions), `r/${index}`),
      ),
    },
    bodyRange,
    problems,
  };
}
