/**
 * The contract diff of two WSDLs (#56 spec §3, §4): which operations and endpoints Update Definition's
 * plan finds added and removed, then per operation both have its transport and its request and
 * response bodies, compared as the JSON Schema the XSD bridge writes for them.
 */
import { diffEndpoints } from '../contract-diff/endpoints.js';
import type { ContractChange, ContractDiff, ContractSide, MessageSide } from '../contract-diff/model.js';
import { sortChanges } from '../contract-diff/model.js';
import { diffSchemas } from '../contract-diff/schema-diff.js';
import { operationJsonSchema } from '../soap/json-operation.js';
import type { OperationRef } from '../soap/request-builder.js';
import type { SoapOperationSummary, WsdlImportResult } from '../soap/types.js';
import { qnameToString } from './qname.js';
import { planUpdate } from './update-definition.js';

const keyOf = (ref: OperationRef): string => `${qnameToString(ref.bindingName)}#${ref.operationName}`;

/** How a report names an operation: its binding's local name and its own. */
export const wsdlOperationLabel = (ref: OperationRef): string => `${ref.bindingName.localName}#${ref.operationName}`;

const SIDES: readonly MessageSide[] = ['request', 'response'];

function transportChanges(
  before: SoapOperationSummary,
  after: SoapOperationSummary,
  operation: string,
): ContractChange[] {
  const changes: ContractChange[] = [];
  if ((before.soapAction ?? '') !== (after.soapAction ?? '')) {
    changes.push({
      kind: 'soap-action-changed',
      severity: 'breaking',
      operation,
      message: `SOAP action "${before.soapAction ?? ''}" became "${after.soapAction ?? ''}"`,
    });
  }
  if (before.soapVersion !== after.soapVersion) {
    changes.push({
      kind: 'soap-version-changed',
      severity: 'breaking',
      operation,
      message: `SOAP ${before.soapVersion} became SOAP ${after.soapVersion}`,
    });
  }
  if (before.style !== after.style) {
    changes.push({
      kind: 'style-changed',
      severity: 'breaking',
      operation,
      message: `style ${before.style} became ${after.style}`,
    });
  }
  return changes;
}

/** Two versions of a WSDL, compared per operation; `old` and `next` name the sides in the report. */
export function diffWsdlContracts(
  oldImport: WsdlImportResult,
  newImport: WsdlImportResult,
  sides: { readonly old: ContractSide; readonly new: ContractSide },
): ContractDiff {
  const plan = planUpdate(oldImport, newImport);
  const changes: ContractChange[] = [];
  const notes = new Set<string>();

  for (const ref of plan.removedOperations) {
    const operation = wsdlOperationLabel(ref);
    changes.push({ kind: 'operation-removed', severity: 'breaking', operation, message: 'operation removed' });
  }
  for (const ref of plan.newOperations) {
    const operation = wsdlOperationLabel(ref);
    changes.push({ kind: 'operation-added', severity: 'compatible', operation, message: 'operation added' });
  }
  changes.push(...diffEndpoints(plan.endpointsRemoved, plan.endpointsAdded));

  const oldByKey = new Map(oldImport.operations.map((summary) => [keyOf(summary), summary]));
  let operationsCompared = 0;
  for (const after of newImport.operations) {
    const before = oldByKey.get(keyOf(after));
    if (before === undefined) {
      continue;
    }
    operationsCompared += 1;
    const ref: OperationRef = { bindingName: after.bindingName, operationName: after.operationName };
    const operation = wsdlOperationLabel(ref);
    changes.push(...transportChanges(before, after, operation));
    for (const side of SIDES) {
      const was = operationJsonSchema(oldImport, ref, side);
      const now = operationJsonSchema(newImport, ref, side);
      for (const note of was.notes) notes.add(`${sides.old.label}: ${note}`);
      for (const note of now.notes) notes.add(`${sides.new.label}: ${note}`);
      changes.push(...diffSchemas(was.schema, now.schema, { side, location: side, operation, xmlOccurrence: true }));
    }
  }

  return {
    format: 'wsdl',
    old: sides.old,
    new: sides.new,
    operationsCompared,
    changes: sortChanges(changes),
    notes: [...notes],
  };
}
