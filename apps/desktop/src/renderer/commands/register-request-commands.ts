import { catalogEntry } from '@shared/command-catalog.js';
import { currentBlocker, openEnvPicker } from '../features/multi-env/multi-env-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useExchangesStore } from '../state/exchanges.js';
import { isMockRunning, useMockRunsStore } from '../state/mock-runs.js';
import { useSequenceRunsStore } from '../state/sequence-runs.js';
import {
  activeGrpcRequestId,
  activeMockId,
  activeRequestId,
  activeRestRequestId,
  activeSequenceId,
  activeWsRequestId,
  activeMcpRequestId,
  ui,
} from './command-helpers.js';

/** Registers every `request.*`/`response.*` command; all act on the active request tab. */
export function registerRequestCommands(): void {
  // Either request kind's fan-out to several environments; opens the picker the editor mounts.
  registerCommand({
    ...catalogEntry('request.sendToEnvironments'),
    when: () => {
      const requestId = activeRequestId() ?? activeRestRequestId();
      return requestId !== undefined && currentBlocker(requestId) === undefined;
    },
    // `editor.request` covers a REST tab too, as `request.cancel` does.
    whenScope: 'editor.request',
    run: () => {
      const soapId = activeRequestId();
      if (soapId !== undefined) {
        openEnvPicker(soapId, 'soap');
        return;
      }
      const restId = activeRestRequestId();
      if (restId !== undefined) {
        openEnvPicker(restId, 'rest');
      }
    },
  });
  registerCommand({
    ...catalogEntry('sequence.run'),
    when: () => {
      const sequenceId = activeSequenceId();
      return sequenceId !== undefined && useSequenceRunsStore.getState().runs[sequenceId]?.status !== 'running';
    },
    whenScope: 'editor.sequence',
    run: () => {
      const sequenceId = activeSequenceId();
      if (sequenceId !== undefined) {
        void useSequenceRunsStore.getState().start(sequenceId);
      }
    },
  });
  registerCommand({
    ...catalogEntry('mock.start'),
    when: () => {
      const mockId = activeMockId();
      return mockId !== undefined && !isMockRunning(useMockRunsStore.getState().states, mockId);
    },
    whenScope: 'editor.mock',
    run: () => {
      const mockId = activeMockId();
      if (mockId !== undefined) {
        void useMockRunsStore.getState().start(mockId);
      }
    },
  });
  registerCommand({
    ...catalogEntry('mock.stop'),
    when: () => {
      const mockId = activeMockId();
      return mockId !== undefined && isMockRunning(useMockRunsStore.getState().states, mockId);
    },
    whenScope: 'editor.mock',
    run: () => {
      const mockId = activeMockId();
      if (mockId !== undefined) {
        void useMockRunsStore.getState().stop(mockId);
      }
    },
  });
  registerCommand({
    ...catalogEntry('sequence.cancel'),
    when: () => {
      const sequenceId = activeSequenceId();
      return sequenceId !== undefined && useSequenceRunsStore.getState().runs[sequenceId]?.status === 'running';
    },
    whenScope: 'editor.sequence',
    run: () => {
      const sequenceId = activeSequenceId();
      if (sequenceId !== undefined) {
        void useSequenceRunsStore.getState().cancel(sequenceId);
      }
    },
  });
  registerCommand({
    ...catalogEntry('request.cancel'),
    // Escape must stay available to dialogs, menus, and the palette, so this command exists
    // only while the active request is actually in flight.
    whenScope: 'editor.request',
    when: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        return useExchangesStore.getState().byRequest[requestId]?.status === 'sending';
      }
      const restRequestId = activeRestRequestId();
      if (restRequestId !== undefined) {
        return useExchangesStore.getState().restByRequest[restRequestId]?.status === 'sending';
      }
      const wsRequestId = activeWsRequestId();
      if (wsRequestId !== undefined) {
        return useExchangesStore.getState().wsByRequest[wsRequestId]?.status === 'connecting';
      }
      const mcpRequestId = activeMcpRequestId();
      if (mcpRequestId !== undefined) {
        return useExchangesStore.getState().mcpByRequest[mcpRequestId]?.status === 'sending';
      }
      const grpcRequestId = activeGrpcRequestId();
      return (
        grpcRequestId !== undefined && useExchangesStore.getState().grpcByRequest[grpcRequestId]?.status === 'sending'
      );
    },
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().cancel(requestId);
        return;
      }
      const restRequestId = activeRestRequestId();
      if (restRequestId !== undefined) {
        void useExchangesStore.getState().cancelRest(restRequestId);
        return;
      }
      const wsRequestId = activeWsRequestId();
      if (wsRequestId !== undefined) {
        void useExchangesStore.getState().cancelWs(wsRequestId);
        return;
      }
      const mcpRequestId = activeMcpRequestId();
      if (mcpRequestId !== undefined) {
        void useExchangesStore.getState().cancelMcp(mcpRequestId);
        return;
      }
      const grpcRequestId = activeGrpcRequestId();
      if (grpcRequestId !== undefined) {
        void useExchangesStore.getState().cancelGrpc(grpcRequestId);
      }
    },
  });

  // The request.* actions the pane's context menu offers, so the palette can reach them too.
  // All of them are gated the same way as `request.send`: they act on the active request tab.

  registerCommand({
    ...catalogEntry('request.showCode'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      ui().openCode();
    },
  });
}
