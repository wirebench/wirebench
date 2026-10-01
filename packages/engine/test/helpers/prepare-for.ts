/**
 * Resolves then connects a selected request with its own module's `resolve…` and `connect…`
 * functions, as a send does around its pre-request script, for the tests that look at what a send
 * would put on the wire. A reference nothing resolves is refused with the module's code, as the
 * send refuses it. No engine code needs this dispatch: a module's `open` does it for itself
 * (ADR-0017), which is why it is not an export.
 */
import { connectGrpc, resolveGrpc } from '../../src/grpc/run.js';
import type { GrpcResolvedInput } from '../../src/grpc/run.js';
import type { SelectedRequest } from '../../src/protocols.js';
import type { PropertyScopes } from '../../src/project/properties.js';
import { connectRest, resolveRest } from '../../src/rest/run.js';
import type { RestSendInput } from '../../src/rest/send.js';
import type { RunContext } from '../../src/run/context.js';
import { unresolvedError } from '../../src/run/send-helpers.js';
import { connectSoap, resolveSoap } from '../../src/soap/run.js';
import type { SoapSendInput } from '../../src/soap/types.js';

/** A request resolved and connected, told apart by `kind`. */
export type Prepared =
  | { readonly kind: 'soap'; readonly input: SoapSendInput; readonly scopes: PropertyScopes }
  | { readonly kind: 'rest'; readonly input: RestSendInput }
  | { readonly kind: 'grpc'; readonly input: GrpcResolvedInput; readonly messageText: string };

/** @throws WirebenchError what the module's `resolve…` and `connect…` throw, or its unresolved code */
export async function prepareFor(selected: SelectedRequest, context: RunContext): Promise<Prepared> {
  switch (selected.kind) {
    case 'soap': {
      const { input, scopes, unresolved } = await resolveSoap(selected, context);
      if (unresolved.length > 0) throw unresolvedError('unresolved-properties', selected.path, unresolved);
      return { kind: 'soap', input: await connectSoap(selected, context, input), scopes };
    }
    case 'rest': {
      const { input, unresolved } = await resolveRest(selected, context);
      if (unresolved.length > 0) throw unresolvedError('rest-unresolved-properties', selected.path, unresolved);
      return { kind: 'rest', input: await connectRest(selected, context, input) };
    }
    case 'grpc': {
      const { input, messageText, unresolved } = await resolveGrpc(selected, context);
      if (unresolved.length > 0) throw unresolvedError('grpc-unresolved-properties', selected.path, unresolved);
      return { kind: 'grpc', input: await connectGrpc(selected, context, input), messageText };
    }
  }
}
