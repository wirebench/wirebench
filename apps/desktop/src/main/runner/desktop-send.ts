/**
 * The Runner's sends (#336): each request goes through `sendThroughEngine`, the path a single send
 * takes, so it gets the auth, TLS, proxy, scripts, HTTP Log row and History entry any send gets, with
 * the run's tags on its History entry. It expands against the run's `${#Sequence#…}` values and the
 * iteration's `${#Data#…}` row, its scripts hand their values to the run (not to the project's
 * session), and the run's stop cancels it through its signal.
 */
import { WirebenchError } from '@wirebench/engine';
import type { RunRequestSender, RunSendOverrides, SelectedRequest, SentRequest, SentScripts } from '@wirebench/engine';
import type { EngineService } from '../engine-service.js';
import { toSendDeps, type RequestChannelDeps } from '../ipc/request.js';
import { sendThroughEngine } from '../send/exchange.js';
import type { McpExchangeSummary } from '../../shared/kinds/mcp/wire.js';
import { draftFor } from '../sequence-runner.js';

export interface DesktopSendDeps {
  readonly service: EngineService;
  readonly requests: RequestChannelDeps;
}

/** Told the engine's sent request before its log row and History entry exist; awaited. */
export type BeforeRows = (sent: SentRequest) => void | Promise<void>;

/** Sends one request of a run, and hands back what assertions and transfers read. */
export type DesktopRunSend = (
  item: SelectedRequest,
  overrides: RunSendOverrides,
  beforeRows?: BeforeRows,
) => Promise<SentRequest>;

/**
 * A sender for one run. `runId` names every send (`<runId>:<n>`) and tags its History entry; `signal`
 * is the run's: aborting it cancels the send in flight.
 *
 * @throws WirebenchError `no-endpoint` for a SOAP request no endpoint resolves for; what the send throws
 */
export function createDesktopRunSend(
  deps: DesktopSendDeps,
  runId: string,
  tags: readonly string[],
  signal: AbortSignal,
): DesktopRunSend {
  const sendDeps = toSendDeps(deps.service, deps.requests);
  // Each MCP command line is asked about once for the whole run, before the first send that runs it.
  const approveCommand = deps.requests.mcpApprovals?.forRun();
  let next = 0;
  return async (item, overrides, beforeRows) => {
    const sendId = `${runId}:${String(next++)}`;
    const requestId = item.request.id;
    if (item.kind === 'soap' && deps.requests.project.endpointFor(requestId) === undefined) {
      throw new WirebenchError('no-endpoint', 'No endpoint resolves for this request');
    }
    let sent: SentRequest | undefined;
    let ran: SentScripts | undefined;
    const stop = (): void => {
      sendDeps.registry.cancel(sendId);
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const sending = sendThroughEngine(sendDeps, sendId, requestId, {
        draft: draftFor(item.kind),
        sequence: overrides.sequence ?? {},
        ...(overrides.data !== undefined ? { data: overrides.data } : {}),
        ...(overrides.iteration !== undefined ? { iteration: overrides.iteration } : {}),
        ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
        tags,
        run: true,
        // The run asked about a protected environment before its first send (`runner-service.ts`).
        protectedConfirmed: true,
        ...(approveCommand !== undefined ? { approveCommand } : {}),
        onScriptsRan: (scripts) => {
          ran = scripts;
        },
        onSent: async (exchange) => {
          sent = exchange;
          await beforeRows?.(exchange);
        },
      });
      // The send holds its id from its first moment: a stop that came just before reaches it too.
      if (signal.aborted) stop();
      const summary = await sending;
      // A WebSocket session's handshake row is already in the HTTP Log, and an MCP send writes none
      // (History is its record); any other request's row is this.
      if (!('handshake' in summary) && item.kind !== 'mcp') {
        deps.requests.onExchange?.({
          kind: 'exchange',
          exchange: summary as Exclude<typeof summary, McpExchangeSummary>,
          requestId,
        });
      }
      if (sent === undefined) {
        throw new WirebenchError('no-response', 'The send ended without a response');
      }
      const script = ran ?? sent.script;
      return {
        ...sent,
        ...(script !== undefined ? { script } : {}),
        ...('scriptsOff' in summary && summary.scriptsOff === true ? { scriptsOff: true } : {}),
      };
    } finally {
      signal.removeEventListener('abort', stop);
    }
  };
}

/** The run loop's sender over a desktop send. */
export function asRunSender(send: DesktopRunSend): RunRequestSender {
  return (item, overrides = {}) => send(item, overrides);
}
