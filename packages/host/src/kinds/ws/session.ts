/**
 * A WebSocket session as the desktop follows it (spec §5.5): opened or not, and its frames' contract
 * checks. `exchange.ts` asks for one for every send of an interactive kind.
 */
import type { LiveEvent, WsExchange, WsFrameContract } from '@wirebench/engine';
import { toWsFrameContractWire } from '../../engine-wire.js';
import type { SendOptions, SendThroughEngineDeps } from '../../send/exchange.js';
import type { DesktopSend } from '../../send/host.js';
import { withContracts, wsContractChecks, type WsContractChecks } from '../../send/ws-contract.js';

/** A WebSocket session as the desktop follows it: opened or not, and its frames' contract checks. */
export interface WsSession {
  /** True once the handshake has opened the session. */
  readonly opened: () => boolean;
  /** Told each live event before it is handed on. */
  seen(event: LiveEvent): void;
  /** Told each live event after it is handed on. */
  forwarded(event: LiveEvent): void;
  /** The exchange with its frames' check results, once every check has answered or run out of time. */
  checked(exchange: WsExchange): Promise<WsExchange>;
  dispose(): Promise<void>;
}

/**
 * A WebSocket session's follower. Its contract is asked for here and never awaited: frames flow
 * while it loads, and one that fails leaves the session unchecked with one console line. Each frame
 * is checked on a worker after its own `frame` event, and its result follows as a `contract` event.
 */
export function wsSessionOf(
  deps: SendThroughEngineDeps,
  sendId: string,
  requestId: string,
  send: DesktopSend,
  onLive: SendOptions['onLive'],
): WsSession {
  let handshakeSeen = false;
  const onContract = (index: number, contract: WsFrameContract): void => {
    try {
      onLive?.({ kind: 'contract', sendId, index, contract: toWsFrameContractWire(contract) });
    } catch (error) {
      console.warn(
        `[ws] a live event ("contract") for send "${sendId}" could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  const checks: WsContractChecks | undefined = wsContractChecks(
    sendId,
    deps.project.wsContractFor?.(requestId),
    deps.wsFrameChecker,
    onContract,
    deps.registry.frameCheckers,
  );
  return {
    // The host's handshake row is written as the socket opens; the live event follows it.
    opened: () => handshakeSeen || send.handshakeLogged === true,
    seen: (event) => {
      if (event.protocol === 'websocket' && event.kind === 'handshake') handshakeSeen = true;
    },
    forwarded: (event) => {
      if (event.protocol === 'websocket' && event.kind === 'frame') checks?.check(event.frame);
    },
    checked: async (exchange) => (checks === undefined ? exchange : withContracts(exchange, await checks.settle())),
    dispose: async () => {
      await checks?.dispose();
    },
  };
}
