/**
 * Builds the operation-picker summary (`OperationSummary[]`) for an imported
 * WSDL definition: every binding operation, cross-referenced with the ports
 * (and their services) that expose it.
 */

import type { Binding, Operation, Service, WsdlDefinition } from './wsdl/model.js';
import { findPortType } from './wsdl/model.js';
import { qnameEquals } from './wsdl/qname.js';
import type { OperationSummary } from './types.js';

/** The services/ports that bind to `binding`, across every service in the definition. */
function portsFor(definition: WsdlDefinition, binding: Binding): OperationSummary['ports'] {
  const ports: { serviceName: Service['name']; portName: string; address?: string }[] = [];
  for (const service of definition.services) {
    for (const port of service.ports) {
      if (qnameEquals(port.binding, binding.name)) {
        ports.push({
          serviceName: service.name,
          portName: port.name,
          ...(port.address !== undefined ? { address: port.address } : {}),
        });
      }
    }
  }
  return ports;
}

/** The abstract `wsdl:operation` behind a binding operation, for its documentation. */
function abstractOperationFor(
  definition: WsdlDefinition,
  binding: Binding,
  operationName: string,
): Operation | undefined {
  const portType = findPortType(definition, binding.type);
  return portType?.operations.find((op) => op.name === operationName);
}

/**
 * Walks every `binding` x `operation` pair in `definition`, mapping each to
 * the ports (and their services) that reference the binding.
 */
export function summarizeOperations(definition: WsdlDefinition): readonly OperationSummary[] {
  const summaries: OperationSummary[] = [];
  for (const binding of definition.bindings) {
    const ports = portsFor(definition, binding);
    for (const operation of binding.operations) {
      const documentation = abstractOperationFor(definition, binding, operation.name)?.documentation;
      summaries.push({
        bindingName: binding.name,
        operationName: operation.name,
        soapVersion: binding.soapVersion,
        ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
        style: operation.style ?? binding.style,
        ...(documentation !== undefined ? { documentation } : {}),
        ports,
      });
    }
  }
  return summaries;
}
