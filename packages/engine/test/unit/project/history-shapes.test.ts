import { describe, expectTypeOf, it } from 'vitest';
import type { McpExchangeTransport } from '#protocol-mcp/mcp/exchange';
import type { McpHttpCall } from '#protocol-mcp/mcp/http-calls';
import type { McpMessage } from '#protocol-mcp/mcp/session';
import type {
  HistoryContract,
  HistoryMcpHttpCall,
  HistoryMcpMessage,
  HistoryMcpTransport,
  HistorySseRow,
  HistoryWsFrame,
} from '#core/project/history';
import type { RestContractResult } from '#protocol-rest/rest/contract-check';
import type { SseRow } from '#core/http/sse';
import type { WsFrame } from '#protocol-ws/ws/model';

// History restates the record shapes the protocols own, so `project/history.ts` names no protocol
// (ADR-0017). These keep each restatement equal to the protocol's own type: a field added on one side
// and not the other fails the type check.
describe('history record shapes', () => {
  it('keeps a WebSocket frame as the WebSocket module defines it', () => {
    expectTypeOf<HistoryWsFrame>().toEqualTypeOf<WsFrame>();
  });

  it('keeps an event-stream row as the REST module defines it', () => {
    expectTypeOf<HistorySseRow>().toEqualTypeOf<SseRow>();
  });

  it('keeps a contract result as the REST module defines it', () => {
    expectTypeOf<HistoryContract>().toEqualTypeOf<RestContractResult>();
  });

  it('keeps an MCP message, HTTP call and transport as the MCP module defines them', () => {
    expectTypeOf<HistoryMcpMessage>().toEqualTypeOf<McpMessage>();
    expectTypeOf<HistoryMcpHttpCall>().toEqualTypeOf<McpHttpCall>();
    expectTypeOf<HistoryMcpTransport>().toEqualTypeOf<McpExchangeTransport>();
  });
});
