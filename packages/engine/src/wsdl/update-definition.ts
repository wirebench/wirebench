/**
 * "Update Definition": re-import a WSDL and reconcile an existing
 * project against it.
 *
 * The two halves are deliberately separate. {@link planUpdate} is a pure diff of
 * two {@link ImportResult}s — what a preview dialog shows before the user commits
 * to anything. {@link applyUpdate} then rewrites the project model per the
 * options the user ticked, and is equally pure: it returns the next `Project`
 * plus the relative paths of the `.xml.bak` backups the save layer should write
 * (see `project/save.ts`'s `backups` option), and never touches a file system
 * itself.
 *
 * Nothing is ever deleted. Requests belonging to an operation the new definition
 * no longer has are kept and flagged {@link RequestDef.orphaned} rather than
 * removed — the user decides whether a vanished operation means "clean
 * this up" or "the new WSDL is wrong".
 */

import { generateRequest } from '../generate.js';
import { createRequest, generateId } from '../project/model.js';
import type { Endpoint, IdGenerator, Interface, OperationDef, Project, RequestDef } from '../project/model.js';
import { INTERFACES_DIR, OPERATIONS_DIR, uniqueSlug } from '../project/paths.js';
import { recreateRequest } from '../soap/recreate.js';
import type { OperationRef } from '../soap/request-builder.js';
import type { ImportResult, OperationSummary } from '../types.js';
import { generateElement, generateType } from '../xsd/sample-generator.js';
import { findBinding, findPortType } from './model.js';
import type { MessageRef, WsdlDefinition } from './model.js';
import type { QName } from './qname.js';
import { qnameToString } from './qname.js';

export type { OperationRef } from '../soap/request-builder.js';

/** Why {@link planUpdate} considers an operation changed; the first applicable reason wins. */
export type OperationChangeReason = 'input-schema' | 'output-schema' | 'soap-action' | 'style' | 'binding';

/** One operation both definitions have, but not identically. */
export interface ChangedOperation {
  readonly ref: OperationRef;
  readonly reason: OperationChangeReason;
}

/** The difference between the definition a project was built from and a freshly imported one. */
export interface UpdatePlan {
  /** Operations only the new definition has. */
  readonly newOperations: readonly OperationRef[];
  /** Operations only the old definition had; their saved requests become orphaned. */
  readonly removedOperations: readonly OperationRef[];
  /** Operations both have, whose generated request or transport metadata differs. */
  readonly changedOperations: readonly ChangedOperation[];
  /** `soap:address` locations the new definition adds. */
  readonly endpointsAdded: readonly string[];
  /** `soap:address` locations the new definition no longer declares. */
  readonly endpointsRemoved: readonly string[];
}

/**
 * Generation options the diff compares envelopes under. Optional content is
 * deliberately *included*: an added `minOccurs="0"` element is a real schema
 * change the user must be told about, even though the default sample envelope
 * would not show it.
 */
const DIFF_GENERATE_OPTIONS = { includeOptional: true, typeComments: false, sampleValues: false } as const;

/** An operation's identity across two definitions: its binding's expanded name plus its own name. */
function operationKey(ref: OperationRef): string {
  return `${qnameToString(ref.bindingName)}#${ref.operationName}`;
}

function refOf(summary: OperationSummary): OperationRef {
  return { bindingName: summary.bindingName, operationName: summary.operationName };
}

/** Every `soap:address` the definition exposes, deduplicated, in document order. */
function addressesOf(summary: readonly OperationSummary[]): string[] {
  const seen = new Set<string>();
  for (const operation of summary) {
    for (const port of operation.ports) {
      if (port.address !== undefined) {
        seen.add(port.address);
      }
    }
  }
  return [...seen];
}

/** The generated sample envelope for one operation, or `undefined` when it cannot be built. */
function envelopeOf(result: ImportResult, ref: OperationRef): string | undefined {
  try {
    return generateRequest(result, ref, DIFF_GENERATE_OPTIONS).envelopeXml;
  } catch {
    return undefined;
  }
}

/**
 * A structural fingerprint of one operation's output message: every part, with
 * the sample fragment its element/type would generate. There is no response
 * builder in the engine, so this stands in for "the response shape changed".
 */
function outputSignature(definition: WsdlDefinition, schemaSet: ImportResult['schemaSet'], ref: OperationRef): string {
  const binding = findBinding(definition, ref.bindingName);
  if (binding === undefined) {
    return '';
  }
  const portType = findPortType(definition, binding.type);
  const operation = portType?.operations.find((candidate) => candidate.name === ref.operationName);
  const output: MessageRef | undefined = operation?.output;
  if (output === undefined) {
    return '';
  }
  const message = definition.messages.find(
    (candidate) => qnameToString(candidate.name) === qnameToString(output.message),
  );
  if (message === undefined) {
    return qnameToString(output.message);
  }
  const parts = message.parts.map((part) => {
    try {
      if (part.element !== undefined) {
        return `${part.name}=${generateElement(schemaSet, part.element, DIFF_GENERATE_OPTIONS).xml}`;
      }
      if (part.type !== undefined) {
        const name: QName = { namespaceUri: '', localName: part.name };
        return `${part.name}=${generateType(schemaSet, name, part.type, DIFF_GENERATE_OPTIONS).xml}`;
      }
    } catch {
      /* An unresolvable part contributes its declared name only. */
    }
    return `${part.name}=?`;
  });
  return parts.join('\n');
}

/** The first reason `next` differs from `previous`, or `undefined` when they match. */
function changeReason(
  oldImport: ImportResult,
  newImport: ImportResult,
  previous: OperationSummary,
  next: OperationSummary,
): OperationChangeReason | undefined {
  if (previous.soapAction !== next.soapAction) {
    return 'soap-action';
  }
  if (previous.style !== next.style) {
    return 'style';
  }
  if (previous.soapVersion !== next.soapVersion) {
    return 'binding';
  }
  if (envelopeOf(oldImport, refOf(previous)) !== envelopeOf(newImport, refOf(next))) {
    return 'input-schema';
  }
  const ref = refOf(next);
  if (
    outputSignature(oldImport.definition, oldImport.schemaSet, ref) !==
    outputSignature(newImport.definition, newImport.schemaSet, ref)
  ) {
    return 'output-schema';
  }
  return undefined;
}

/**
 * Diffs two imports of the same interface: what the new definition adds, drops
 * and changes. Operation identity is the binding's expanded name plus the
 * operation name, so a renamed binding reads as "every operation removed, every
 * operation added" — which is what it is.
 *
 * Pure and deterministic: the lists follow the new definition's document order
 * (removed operations follow the old one's).
 *
 * @param oldImport the definition the project was built from
 * @param newImport the freshly fetched definition
 */
export function planUpdate(oldImport: ImportResult, newImport: ImportResult): UpdatePlan {
  const oldByKey = new Map(oldImport.operations.map((op) => [operationKey(refOf(op)), op]));
  const newByKey = new Map(newImport.operations.map((op) => [operationKey(refOf(op)), op]));

  const newOperations: OperationRef[] = [];
  const changedOperations: ChangedOperation[] = [];
  for (const [key, next] of newByKey) {
    const previous = oldByKey.get(key);
    if (previous === undefined) {
      newOperations.push(refOf(next));
      continue;
    }
    const reason = changeReason(oldImport, newImport, previous, next);
    if (reason !== undefined) {
      changedOperations.push({ ref: refOf(next), reason });
    }
  }

  const removedOperations: OperationRef[] = [];
  for (const [key, previous] of oldByKey) {
    if (!newByKey.has(key)) {
      removedOperations.push(refOf(previous));
    }
  }

  const oldAddresses = addressesOf(oldImport.operations);
  const newAddresses = addressesOf(newImport.operations);
  return {
    newOperations,
    removedOperations,
    changedOperations,
    endpointsAdded: newAddresses.filter((address) => !oldAddresses.includes(address)),
    endpointsRemoved: oldAddresses.filter((address) => !newAddresses.includes(address)),
  };
}

/**
 * What {@link applyUpdate} is allowed to do, named after the checkboxes of
 * the Update Definition dialog.
 */
export interface ApplyUpdateOptions {
  /** "Create new requests": add a `Request 1` for every operation the new definition adds. */
  readonly createNewRequests: boolean;
  /** "Recreate requests": regenerate the envelopes of every changed operation's requests. */
  readonly recreateRequests: boolean;
  /** "Recreate optional elements": include `minOccurs="0"` content when regenerating. */
  readonly recreateOptional: boolean;
  /** "Keep existing values": copy matching leaf values across (Task 29's merge). */
  readonly keepExisting: boolean;
  /** "Keep SOAP headers": keep the current `soapenv:Header` verbatim. */
  readonly keepSoapHeaders: boolean;
  /** "Create backups": ask the save layer for a `<request>.xml.bak` of every rewritten envelope. */
  readonly createBackups: boolean;
  /** "Update TestRequests": not implemented in this phase; the dialog shows it disabled. */
  readonly updateTestRequests: false;
  /** Mints ids for created requests and endpoints; injected by tests for determinism. */
  readonly newId?: IdGenerator;
}

/** What {@link applyUpdate} did, in ids the caller can select in the UI. */
export interface ApplyUpdateResult {
  readonly project: Project;
  /** Ids of requests created for newly added operations. */
  readonly requestsCreated: readonly string[];
  /** Ids of requests whose envelope was regenerated. */
  readonly requestsRecreated: readonly string[];
  /** Ids of requests now flagged `orphaned` because their operation is gone. */
  readonly requestsOrphaned: readonly string[];
  /**
   * Relative, `/`-separated project paths of the `.xml.bak` files the save layer
   * should write before overwriting the corresponding envelope.
   */
  readonly backups: readonly string[];
}

function requireInterface(project: Project, interfaceId: string): Interface {
  const iface = project.interfaces.find((candidate) => candidate.id === interfaceId);
  if (iface === undefined) {
    throw new Error(`No interface with id "${interfaceId}"`);
  }
  return iface;
}

/** The `.xml.bak` path of one saved request, relative to the project root. */
function backupPath(iface: Interface, operation: OperationDef, request: RequestDef): string {
  return `${INTERFACES_DIR}/${iface.slug}/${OPERATIONS_DIR}/${operation.slug}/${request.slug}.xml.bak`;
}

/** The operation summary for `ref` in the new import, if the new definition still has it. */
function summaryFor(result: ImportResult, key: string): OperationSummary | undefined {
  return result.operations.find((op) => operationKey(refOf(op)) === key);
}

/** Adds the endpoints `plan.endpointsAdded` names, skipping URLs the interface already has. */
function withAddedEndpoints(iface: Interface, plan: UpdatePlan, newId: IdGenerator): Interface {
  const known = new Set(iface.endpoints.map((endpoint) => endpoint.url));
  const added: Endpoint[] = plan.endpointsAdded
    .filter((url) => !known.has(url))
    .map((url) => ({ id: newId(), name: url, url, authMode: 'complement' as const }));
  if (added.length === 0) {
    return iface;
  }
  const endpoints = [...iface.endpoints, ...added];
  return {
    ...iface,
    endpoints,
    ...(iface.defaultEndpointId === undefined && endpoints[0] !== undefined
      ? { defaultEndpointId: endpoints[0].id }
      : {}),
  };
}

/**
 * Applies `plan` to one interface of `project`, per `options`.
 *
 * Never deletes anything: a removed operation's requests stay exactly where they
 * are with `orphaned: true`, and an operation the new definition brought back has
 * that flag cleared again.
 *
 * @param project the model to update; never mutated
 * @param interfaceId the interface the plan belongs to
 * @param plan the diff from {@link planUpdate}
 * @param newImport the freshly imported definition the plan was built against
 * @param options which of the update behaviours to perform
 * @throws Error when `interfaceId` names no interface of `project`
 */
export function applyUpdate(
  project: Project,
  interfaceId: string,
  plan: UpdatePlan,
  newImport: ImportResult,
  options: ApplyUpdateOptions,
): ApplyUpdateResult {
  const newId = options.newId ?? generateId;
  let iface = requireInterface(project, interfaceId);

  const requestsCreated: string[] = [];
  const requestsRecreated: string[] = [];
  const requestsOrphaned: string[] = [];
  const backups: string[] = [];

  const removedKeys = new Set(plan.removedOperations.map(operationKey));
  const changedByKey = new Map(plan.changedOperations.map((changed) => [operationKey(changed.ref), changed]));

  const generateOptions = { includeOptional: options.recreateOptional } as const;

  // Pass 1: orphan flags and recreated envelopes, operation by operation.
  const operations: OperationDef[] = iface.operations.map((operation) => {
    const key = `${operation.bindingName}#${operation.name}`;
    const orphaned = removedKeys.has(key);
    const recreate = options.recreateRequests && changedByKey.has(key);
    const requests = operation.requests.map((request) => {
      let next: RequestDef = request;
      if (orphaned) {
        if (request.orphaned !== true) {
          requestsOrphaned.push(request.id);
        }
        next = { ...next, orphaned: true };
      } else if (request.orphaned === true) {
        // `exactOptionalPropertyTypes`: the flag is *absent* again, not `undefined`.
        next = Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'orphaned')) as RequestDef;
      }
      if (recreate) {
        const summary = summaryFor(newImport, key);
        if (summary !== undefined) {
          const generated = generateRequest(newImport, refOf(summary), generateOptions);
          const merged = recreateRequest(next.envelopeXml, generated.envelopeXml, {
            keepValues: options.keepExisting,
            keepHeaders: options.keepSoapHeaders,
          });
          if (options.createBackups) {
            backups.push(backupPath(iface, operation, request));
          }
          requestsRecreated.push(request.id);
          next = {
            ...next,
            envelopeXml: merged.xml,
            soapVersion: generated.soapVersion,
            ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
          };
        }
      }
      return next;
    });
    return { ...operation, requests };
  });
  iface = { ...iface, operations };

  // Pass 2: an operation folder (and its first request) for everything the new definition adds.
  if (options.createNewRequests) {
    for (const ref of plan.newOperations) {
      const summary = summaryFor(newImport, operationKey(ref));
      if (summary === undefined) {
        continue;
      }
      const bindingName = qnameToString(ref.bindingName);
      const existing = iface.operations.find((op) => op.bindingName === bindingName && op.name === ref.operationName);
      const operation: OperationDef = existing ?? {
        name: ref.operationName,
        bindingName,
        slug: uniqueSlug(ref.operationName, new Set(iface.operations.map((op) => op.slug))),
        order: iface.operations.length,
        requests: [],
      };
      const generated = generateRequest(newImport, ref, generateOptions);
      const name = 'Request 1';
      const request = createRequest(name, {
        id: newId(),
        envelopeXml: generated.envelopeXml,
        soapVersion: generated.soapVersion,
        slug: uniqueSlug(name, new Set(operation.requests.map((r) => r.slug))),
        order: operation.requests.length,
        ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
        ...(iface.defaultEndpointId !== undefined ? { endpointId: iface.defaultEndpointId } : {}),
      });
      requestsCreated.push(request.id);
      const withRequest: OperationDef = { ...operation, requests: [...operation.requests, request] };
      iface = {
        ...iface,
        operations:
          existing === undefined
            ? [...iface.operations, withRequest]
            : iface.operations.map((op) => (op === existing ? withRequest : op)),
      };
    }
  }

  iface = withAddedEndpoints(iface, plan, newId);
  iface = {
    ...iface,
    definitionUrl: newImport.bundle.root.location,
    ...(newImport.definition.targetNamespace !== '' ? { targetNamespace: newImport.definition.targetNamespace } : {}),
  };

  return {
    project: {
      ...project,
      interfaces: project.interfaces.map((candidate) => (candidate.id === interfaceId ? iface : candidate)),
    },
    requestsCreated,
    requestsRecreated,
    requestsOrphaned,
    backups,
  };
}
