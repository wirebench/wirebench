/**
 * MCP's steps of a desktop send (spec §5.5; #79): the item with the editor's draft, its live
 * messages, its summary, History and audit row. An MCP send writes no HTTP Log row: History is its
 * record (spec, "Desktop").
 */
import type { Redactor } from '../../host/redactor.js';
import { commandDisplay, mcpEffectiveAuth, mcpItemFor, redactMcpExchange } from '@wirebench/engine';
import type { McpExchange, McpMessage, SentRequest } from '@wirebench/engine';
import { recordMcp } from '../../send/record.js';
import type { McpExchangeSummary, McpMessageWire } from '../../../shared/kinds/mcp/wire.js';
import { apiKeyMasks } from '../key-masks.js';
import type { KindSend } from '../kind-main.js';
import { withMcpPatch } from './mutations.js';

/** A plain JSON copy: the engine's read-only arrays as the wire's own, and no `undefined` keys. */
function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The exchange as a person may be shown it: as it is when the session shows secrets, else redacted. */
function shown(redactor: Redactor, exchange: McpExchange, show: boolean): McpExchange {
  return show ? exchange : redactMcpExchange(exchange, { text: (text) => redactor.redactSecretValues(text) });
}

/** One message as the renderer receives it, its text masked unless the session shows secrets. */
export function toMcpMessageWire(redactor: Redactor, message: McpMessage, show: boolean): McpMessageWire {
  const mask = (text: string): string => (show ? text : redactor.redactSecretValues(text));
  return plain<McpMessageWire>({ ...message, text: mask(message.text), warnings: message.warnings.map(mask) });
}

/** The exchange as `request.sendMcp` answers it. */
export function toMcpExchangeSummary(
  redactor: Redactor,
  exchange: McpExchange,
  sendId: string,
  show: boolean,
): McpExchangeSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { kind, ...rest } = shown(redactor, exchange, show);
  return plain<McpExchangeSummary>({ ...rest, sendId });
}

/** Where a send went, as the audit log names it: the URL, or the command line. */
function targetOf(exchange: McpExchange): string {
  const { transport } = exchange;
  return transport.type === 'stdio' ? commandDisplay(transport.command, transport.args) : transport.url;
}

export const mcpSend: KindSend<'mcp'> = {
  selected(project, requestId, draft) {
    const found = mcpItemFor(project, requestId);
    return found === undefined || draft.draft === undefined
      ? found
      : { ...found, request: withMcpPatch(found.request, draft.draft) };
  },

  liveEvent(redactor, sendId, event, show) {
    return { kind: 'message', sendId, message: toMcpMessageWire(redactor, event.message, show) };
  },

  summarise({ deps, sendId, sent, show }) {
    return { summary: toMcpExchangeSummary(deps.hostState.redactor, mcpSent(sent).mcp, sendId, show) };
  },

  async record(deps, recorded, sent) {
    await recordMcp(deps, recorded.item, mcpSent(sent).mcp, recorded.label);
  },

  async recordFailure(deps, recorded, failed) {
    // A session cancelled, or one of a run's that could not finish, settled with its exchange;
    // one refused before it reached the wire (a command not approved) has none and leaves no entry.
    const exchange = failed.exchange as McpExchange | undefined;
    if (exchange === undefined) return;
    await recordMcp(deps, recorded.item, exchange, recorded.label);
  },

  sentAudit(exchange, summary) {
    const { mcp } = exchange;
    const post = mcp.transport.type === 'http' ? mcp.httpCalls?.findLast((call) => call.method === 'POST') : undefined;
    const answered = mcp.failure === undefined && mcp.error === undefined;
    return {
      method: mcp.method,
      url: targetOf(mcp),
      status: post !== undefined && post.status !== 0 ? post.status : null,
      outcome: answered ? 'ok' : 'failed',
      durationMs: summary.durationMs,
    };
  },

  failedAudit(_item, failed) {
    const exchange = failed.exchange as McpExchange | undefined;
    return exchange === undefined
      ? undefined
      : {
          method: exchange.method,
          url: targetOf(exchange),
          status: null,
          outcome: 'failed',
          durationMs: failed.durationMs,
        };
  },

  keyMasks(item) {
    return apiKeyMasks(mcpEffectiveAuth(item));
  },
};

/** The MCP exchange a send settled with. */
export function mcpSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'mcp' }> {
  if (sent.exchange?.kind !== 'mcp') throw new Error('An MCP send came back without its exchange');
  return sent.exchange;
}
