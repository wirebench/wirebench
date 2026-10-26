/**
 * MCP's IPC channels (spec §5.4; #79), registered through its `registerChannels`: the send and its
 * cancel, the catalogue refresh, and this machine's stdio approvals with the prompt's answer.
 */
import type { Caller } from '../../host/platform.js';
import { mcpServersOf, refreshMcpCatalogue, WirebenchError } from '@wirebench/engine';
import { channels, events } from '../../../shared/ipc.js';
import type { McpApprovalPromptEvent } from '../../../shared/kinds/mcp/wire.js';
import { emitEvent } from '../../ipc/events.js';
import { registerHandler, type HandlerTable } from '../../ipc/register.js';
import { toSendDeps } from '../../ipc/request.js';
import type { McpApprovals, McpPromptWindow } from '../../mcp-approvals.js';
import { appSendScope, sendThroughEngine } from '../../send/exchange.js';
import type { KindChannelDeps } from '../kind-main.js';
import { mcpArgumentsCheck } from './arguments-check.js';
import { toMcpMessageWire } from './send.js';

/** A window as the approval prompt reaches it: `mcp.approval` sent to it, and told when it goes away. */
export function promptWindowOf(contents: Caller): McpPromptWindow {
  return {
    prompt: (event: McpApprovalPromptEvent) => {
      if (contents.isClosed()) return false;
      emitEvent(contents, events.mcp.approval, event);
      return true;
    },
    onGone: (gone) => contents.onClosed(gone),
  };
}

/** The approvals the app was built with, or the refusal a build without them gives. */
function requireApprovals(approvals: McpApprovals | undefined): McpApprovals {
  if (approvals === undefined) throw new WirebenchError('not-supported', 'This build keeps no MCP approvals');
  return approvals;
}

/** Registers MCP's channels (spec §5.4). */
export function registerMcpChannels(table: HandlerTable, deps: KindChannelDeps): void {
  const sendDeps = toSendDeps(deps.engine, deps.request);
  const approvals = deps.request.mcpApprovals;

  // One session per send: the invoke stays pending until it closes, while `mcp.live` reports each
  // message. A stdio command line not approved yet is asked about in the window that sent it.
  registerHandler(table, channels.request.sendMcp, (request, sender) =>
    sendThroughEngine(sendDeps, request.sendId, request.requestId, {
      draft: { kind: 'mcp', ...(request.draft !== undefined ? { draft: request.draft } : {}) },
      checkAssertions: true,
      ...(approvals !== undefined ? { approveCommand: approvals.approver(promptWindowOf(sender)) } : {}),
      onLive: (live) => {
        emitEvent(sender, events.mcp.live, live);
      },
    }),
  );
  registerHandler(table, channels.request.cancelMcp, (request) =>
    Promise.resolve(sendDeps.registry.cancel(request.sendId)),
  );
  registerHandler(table, channels.request.mcpArgumentsCheck, (request) =>
    Promise.resolve({ problems: mcpArgumentsCheck(request.text, request.schema) }),
  );

  registerHandler(table, channels.api.refreshMcpCatalogue, async (request, sender) => {
    const sendId = request.sendId ?? `refresh:${request.apiId}`;
    const located = await appSendScope(sendDeps, request.apiId, {
      sendId,
      ...(approvals !== undefined ? { approveCommand: approvals.approver(promptWindowOf(sender)) } : {}),
    });
    const server =
      located === undefined ? undefined : mcpServersOf(located.project).find((s) => s.id === request.apiId);
    const projectId = deps.request.project.projectId(request.apiId);
    if (located === undefined || server === undefined || projectId === undefined) {
      throw new WirebenchError('unknown-entity', `No MCP server with id "${request.apiId}"`, {
        details: { apiId: request.apiId },
      });
    }
    const show = deps.request.showSecrets?.get() ?? false;
    const refreshed = await refreshMcpCatalogue(server, located.scope, located.host, {
      ...(request.sendId !== undefined
        ? {
            onMessage: (message) => {
              emitEvent(sender, events.mcp.live, { kind: 'message', sendId, message: toMcpMessageWire(message, show) });
            },
          }
        : {}),
    });
    await deps.router.setMcpCatalogue(request.apiId, refreshed);
    const { catalogue } = refreshed;
    return {
      projectId,
      info: { ...refreshed.info, serverInfo: { ...refreshed.info.serverInfo } },
      counts: {
        tools: catalogue.tools?.length ?? 0,
        resources: catalogue.resources?.length ?? 0,
        resourceTemplates: catalogue.resourceTemplates?.length ?? 0,
        prompts: catalogue.prompts?.length ?? 0,
      },
      warnings: [...refreshed.warnings],
    };
  });

  registerHandler(table, channels.app.mcpApprovals, async () => ({
    approvals: await requireApprovals(approvals).list(),
  }));
  registerHandler(table, channels.app.mcpRevokeApproval, async (request) => ({
    approvals: await requireApprovals(approvals).revoke(request.fingerprint),
  }));
  registerHandler(table, channels.app.mcpApprove, (request) => {
    requireApprovals(approvals).answer(request.promptId, request.answer);
    return Promise.resolve({});
  });
}
