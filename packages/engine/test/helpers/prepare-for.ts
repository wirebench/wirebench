/**
 * Resolves then connects a selected request with its own module's `resolve…` and `connect…`
 * functions, as a send does around its pre-request script, for the tests that look at what a send
 * would put on the wire. A reference nothing resolves is refused with the module's code, as the
 * send refuses it. No engine code needs this dispatch: a module's `open` does it for itself
 * (ADR-0017), which is why it is not an export.
 */
import { connectGrpc, resolveGrpc } from '#protocol-grpc/grpc/run';
import type { GrpcResolvedInput } from '#protocol-grpc/grpc/run';
import type { SelectedRequest } from '../../src/protocols.js';
import { resolveMcp } from '#protocol-mcp/mcp/run';
import type { McpResolvedInput } from '#protocol-mcp/mcp/run';
import type { PropertyScopes } from '#core/project/properties';
import { connectRest, resolveRest } from '#protocol-rest/rest/run';
import type { RestSendInput } from '#protocol-rest/rest/send';
import type { RunContext } from '#core/run/context';
import { unresolvedError } from '#core/run/send-helpers';
import { connectSoap, resolveSoap } from '#protocol-soap/soap/run';
import type { SoapSendInput } from '#protocol-soap/soap/types';
import type { WsCallInput } from '#protocol-ws/ws/expand';
import { resolveWs } from '#protocol-ws/ws/run';

/** A request resolved and connected, told apart by `kind`. */
export type Prepared =
  | { readonly kind: 'soap'; readonly input: SoapSendInput; readonly scopes: PropertyScopes }
  | { readonly kind: 'rest'; readonly input: RestSendInput }
  | { readonly kind: 'grpc'; readonly input: GrpcResolvedInput; readonly messageText: string }
  // Resolved only: a WebSocket request connects as it opens its session.
  | { readonly kind: 'websocket'; readonly input: WsCallInput }
  // Resolved only: an MCP request connects as it opens its session, after the approval.
  | { readonly kind: 'mcp'; readonly input: McpResolvedInput };

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
    case 'websocket': {
      const { input, unresolved } = await resolveWs(selected, context);
      if (unresolved.length > 0) throw unresolvedError('ws-unresolved-properties', selected.path, unresolved);
      return { kind: 'websocket', input };
    }
    case 'mcp': {
      const { input, unresolved } = await resolveMcp(selected, context);
      if (unresolved.length > 0) throw unresolvedError('mcp-unresolved-properties', selected.path, unresolved);
      return { kind: 'mcp', input };
    }
  }
}
