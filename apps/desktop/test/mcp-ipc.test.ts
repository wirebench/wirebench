// @vitest-environment node
/**
 * MCP's channels in main (#79), against a real project host and the stdio fixture: a server and its
 * request saved and read back, *Refresh catalogue* writing `catalogue.json`, and the approval prompt
 * as a round trip to a mock renderer that answers `mcp.approval` through `app.mcpApprove`.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_STDIO_FIXTURE } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import type { KindChannelDeps } from '../src/main/kinds/kind-main.js';
import type { McpHost } from '../src/main/kinds/mcp/host.js';
import { registerMcpChannels } from '../src/main/kinds/mcp/ipc.js';
import { MCP_APPROVALS_FILE, McpApprovals, McpApprovalStore } from '../src/main/mcp-approvals.js';
import { ProjectHost } from '../src/main/project-host.js';
import type { McpApprovalAnswerWire, McpApprovalPromptEvent } from '../src/shared/kinds/mcp/wire.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

/** A renderer window: it records every event, and answers an approval prompt as `answer` says. */
function mockRenderer(answer: McpApprovalAnswerWire) {
  const sent: { channel: string; payload: unknown }[] = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    once: () => undefined,
    removeListener: () => undefined,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
      if (channel === 'mcp.approval') {
        const { promptId } = payload as McpApprovalPromptEvent;
        // The dialog's button, as the renderer would answer it, after the event is handled.
        setTimeout(() => void invoke('app.mcpApprove', { promptId, answer }, sender), 0);
      }
    },
  };
  return { sender, sent, prompts: () => sent.filter((event) => event.channel === 'mcp.approval') };
}

async function invoke(channel: string, payload: unknown, sender: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  const reply = (await handler({ sender }, payload)) as { ok: boolean; value?: unknown; error?: { code: string } };
  if (!reply.ok) throw Object.assign(new Error(reply.error?.code), { code: reply.error?.code });
  return reply.value;
}

let root: string;
let host: ProjectHost;
let approvals: McpApprovals;

beforeEach(async () => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'wirebench-mcp-ipc-'));
  host = new ProjectHost(new EngineService(), {});
  await host.create({ dir: join(root, 'Demo'), name: 'Demo' });
  approvals = new McpApprovals({ store: new McpApprovalStore(join(root, 'userData', MCP_APPROVALS_FILE)) });
  const request = {
    project: {
      projectId: () => host.snapshot()?.id,
      runContextFor: (id: string, envId?: string) => host.runContextFor(id, envId),
    } as unknown as RequestChannelDeps['project'],
    mcpApprovals: approvals,
  } satisfies RequestChannelDeps;
  registerMcpChannels({
    engine: new EngineService(),
    request,
    router: {
      setMcpCatalogue: (apiId: string, refreshed: Parameters<McpHost['setMcpCatalogue']>[1]) =>
        host.kind('mcp').setMcpCatalogue(apiId, refreshed),
    },
  } as unknown as KindChannelDeps);
});

afterEach(async () => {
  await host.close();
  await rm(root, { recursive: true, force: true });
});

/** An MCP server on the stdio fixture, with one request that calls `echo`. */
async function seedServer(): Promise<{ apiId: string; requestId: string }> {
  const server = await host.mutate({
    kind: 'add-mcp-server',
    name: 'Fixture',
    transport: { type: 'stdio', command: process.execPath, args: [MCP_STDIO_FIXTURE, 'sdk'], env: [] },
  });
  const apiId = server.createdId!;
  const request = await host.mutate({
    kind: 'add-mcp-request',
    apiId,
    name: 'Echo',
    operation: { method: 'tools/call', tool: 'echo', arguments: '{"text":"hi"}' },
  });
  await host.save({ reason: 'test' });
  return { apiId, requestId: request.createdId! };
}

describe('an MCP server in a project', () => {
  it('saves and reads back the server and its request', async () => {
    const { apiId, requestId } = await seedServer();
    const dir = join(root, 'Demo');
    await host.close();
    host = new ProjectHost(new EngineService(), {});
    const opened = await host.openProject(dir);
    expect(opened.mcpServers).toEqual([
      expect.objectContaining({
        id: apiId,
        name: 'Fixture',
        transport: { type: 'stdio', command: process.execPath, args: [MCP_STDIO_FIXTURE, 'sdk'], env: [] },
      }),
    ]);
    expect(opened.mcpRequests).toEqual([
      expect.objectContaining({
        id: requestId,
        apiId,
        operation: { method: 'tools/call', tool: 'echo', arguments: '{"text":"hi"}' },
      }),
    ]);
    expect(opened.unsupported).toBeUndefined();
  });
});

describe('the MCP channels', () => {
  it('refreshes the catalogue into catalogue.json after the renderer allows the command once', async () => {
    const { apiId } = await seedServer();
    const renderer = mockRenderer('once');
    const refreshed = (await invoke('api.refreshMcpCatalogue', { apiId, sendId: 'r-1' }, renderer.sender)) as {
      info: { serverInfo: { name: string; version: string } };
      counts: { tools: number };
    };
    expect(refreshed.info.serverInfo).toEqual({ name: 'fixture', version: '1.2.3' });
    expect(refreshed.counts.tools).toBe(3);
    expect(renderer.prompts()).toHaveLength(1);
    // Its messages streamed on `mcp.live`, under the refresh's id.
    expect(renderer.sent.some((event) => event.channel === 'mcp.live')).toBe(true);

    const server = host.snapshot()!.mcpServers[0]!;
    expect(server.catalogue?.tools?.map((tool) => tool.name)).toEqual(['echo', 'env', 'fail']);
    expect(server.catalogueInfo?.serverInfo.name).toBe('fixture');
    const file = join(root, 'Demo', 'apis', server.slug, 'catalogue.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ tools: [{ name: 'echo' }, {}, {}] });
    // Run once kept nothing.
    expect(await invoke('app.mcpApprovals', undefined, renderer.sender)).toEqual({ approvals: [] });
  });

  it('sends after Always allow, keeps the approval, does not ask again, and asks again once revoked', async () => {
    const { requestId } = await seedServer();
    const renderer = mockRenderer('always');
    const first = (await invoke('request.sendMcp', { sendId: 's-1', requestId }, renderer.sender)) as {
      result: unknown;
    };
    expect(first.result).toMatchObject({ content: [{ type: 'text', text: 'hi' }] });
    expect(renderer.prompts()).toHaveLength(1);
    const { approvals: kept } = (await invoke('app.mcpApprovals', undefined, renderer.sender)) as {
      approvals: { fingerprint: string; serverName?: string }[];
    };
    expect(kept).toEqual([expect.objectContaining({ serverName: 'Fixture' })]);

    await invoke('request.sendMcp', { sendId: 's-2', requestId }, renderer.sender);
    expect(renderer.prompts()).toHaveLength(1);

    expect(await invoke('app.mcpRevokeApproval', { fingerprint: kept[0]!.fingerprint }, renderer.sender)).toEqual({
      approvals: [],
    });
    await invoke('request.sendMcp', { sendId: 's-3', requestId }, renderer.sender);
    expect(renderer.prompts()).toHaveLength(2);
  });

  it('refuses the send when the renderer cancels the prompt', async () => {
    const { requestId } = await seedServer();
    const renderer = mockRenderer('cancel');
    const error = await invoke('request.sendMcp', { sendId: 's-1', requestId }, renderer.sender).catch(
      (caught: unknown) => caught,
    );
    expect((error as { code?: string }).code).toBe('mcp-command-unapproved');
  });

  it('answers a cancel for a send that is not in flight', async () => {
    expect(await invoke('request.cancelMcp', { sendId: 'none' }, mockRenderer('cancel').sender)).toEqual({
      cancelled: false,
    });
  });

  it("checks a tool call's arguments against the input schema, sending nothing", async () => {
    const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
    const sender = mockRenderer('cancel');
    expect(await invoke('request.mcpArgumentsCheck', { text: '{"text":"hi"}', schema }, sender.sender)).toEqual({
      problems: [],
    });
    expect(await invoke('request.mcpArgumentsCheck', { text: '{"text":1}', schema }, sender.sender)).toEqual({
      problems: [expect.objectContaining({ severity: 'warning', pointer: '/text', keyword: 'type' })],
    });
    expect(sender.sent).toEqual([]);
  });
});
