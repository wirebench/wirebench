import { describe, expectTypeOf, it } from 'vitest';
import type { McpExchangeTransport } from '../../../src/mcp/exchange.js';
import type { McpHttpCall } from '../../../src/mcp/http-calls.js';
import type { McpMessage } from '../../../src/mcp/session.js';
import type {
  HistoryContract,
  HistoryMcpHttpCall,
  HistoryMcpMessage,
  HistoryMcpTransport,
  HistorySseRow,
  HistoryWsFrame,
} from '../../../src/project/history.js';
import type { RestContractResult } from '../../../src/rest/contract-check.js';
import type { SseRow } from '../../../src/http/sse.js';
import type { WsFrame } from '../../../src/ws/model.js';

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
