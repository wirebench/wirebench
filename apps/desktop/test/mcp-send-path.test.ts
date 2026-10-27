// @vitest-environment node
/**
 * An MCP send through main (#79): the saved request with the editor's draft, one session against the
 * stdio fixture, its live messages, its summary and its History entry. An MCP send writes no HTTP Log
 * row, and a stdio command line runs only once its host approved it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_STDIO_FIXTURE } from '@wirebench/engine/test-helpers';
import { createMcpFolder, createMcpRequest, createMcpServer, createProject } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { HistoryService } from '../src/main/history-service.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import { draftFor } from '../src/main/sequence-runner.js';
import type { McpLiveEvent } from '@wirebench/wire/kinds/mcp/wire';
import type { HistoryEntryWire } from '@wirebench/wire/wire-types';
import { sendDepsFor } from './helpers/send-deps.js';
import { createHostState } from '../src/main/host/host-state.js';

const hostState = createHostState();

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

let userDataDir: string;

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-mcp-send-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

function project(): Project {
  const server = createMcpServer('Fixture', {
    id: 's-1',
    transport: { type: 'stdio', command: process.execPath, args: [MCP_STDIO_FIXTURE, 'sdk'], env: [] },
    folders: [
      createMcpFolder('Tools', {
        id: 'f-1',
        requests: [
          createMcpRequest('Echo', {
            id: 'q-echo',
            operation: { method: 'tools/call', tool: 'echo', arguments: '{"text":"saved"}' },
          }),
          createMcpRequest('Fail', { id: 'q-fail', operation: { method: 'tools/call', tool: 'fail', arguments: '' } }),
        ],
      }),
    ],
  });
  return { ...createProject('Demo', { id: 'p1' }), containers: { mcp: [server] } };
}

async function setUp(approve: boolean | undefined) {
  const history = new HistoryService(userDataDir, hostState.redactor);
  await history.open('p1');
  const appended: HistoryEntryWire[] = [];
  const onExchange = vi.fn();
  const onSendFailed = vi.fn();
  const approveCommand = vi.fn(() => Promise.resolve(approve === true));
  const deps = sendDepsFor(project(), {
    hostState,
    projectDir: userDataDir,
    history,
    onHistoryAppended: (entry) => appended.push(entry),
    onExchange,
    onSendFailed,
    ...(approve !== undefined ? { approveCommand } : {}),
  });
  return { deps, history, appended, onExchange, onSendFailed, approveCommand };
}

describe('an MCP send through main', () => {
  it('sends the draft over stdio, reports each message live, and records History but no Log row', async () => {
    const { deps, appended, onExchange, onSendFailed, approveCommand } = await setUp(true);
    const live: McpLiveEvent[] = [];
    const summary = await sendThroughEngine(deps, 'send-1', 'q-echo', {
      draft: {
        kind: 'mcp',
        draft: { operation: { method: 'tools/call', tool: 'echo', arguments: '{"text":"draft"}' } },
      },
      checkAssertions: true,
      onLive: (event) => live.push(event),
    });

    expect(approveCommand).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'Fixture', cwd: userDataDir, envNames: [] }),
    );
    expect(summary).toMatchObject({ sendId: 'send-1', method: 'tools/call', transport: { type: 'stdio' } });
    expect(summary.result).toMatchObject({ content: [{ type: 'text', text: 'draft' }] });
    expect(summary.failure).toBeUndefined();
    expect(live.length).toBe(summary.messages.length);
    expect(live.every((event) => event.kind === 'message' && event.sendId === 'send-1')).toBe(true);

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      kind: 'mcp',
      requestId: 'q-echo',
      requestName: 'Echo',
      interfaceName: 'Fixture',
      operationName: 'Tools',
      method: 'tools/call',
      ok: true,
    });
    expect(appended[0]!.mcp?.messages.length).toBeGreaterThan(0);
    expect(onExchange).not.toHaveBeenCalled();
    expect(onSendFailed).not.toHaveBeenCalled();
  });

  it('records a tool that answers isError as not ok', async () => {
    const { deps, appended } = await setUp(true);
    const summary = await sendThroughEngine(deps, 'send-2', 'q-fail', { draft: { kind: 'mcp' } });
    expect(summary.result).toMatchObject({ isError: true });
    expect(appended[0]).toMatchObject({ kind: 'mcp', ok: false });
  });

  it('refuses a stdio command line nobody approved, with no History and no Log row', async () => {
    for (const approve of [false, undefined]) {
      const { deps, appended, onExchange, onSendFailed } = await setUp(approve);
      const error = await sendThroughEngine(deps, 'send-3', 'q-echo', { draft: { kind: 'mcp' } }).catch(
        (caught: unknown) => caught,
      );
      expect((error as { code?: string }).code).toBe('mcp-command-unapproved');
      expect(appended).toEqual([]);
      expect(onExchange).not.toHaveBeenCalled();
      expect(onSendFailed).not.toHaveBeenCalled();
    }
  });

  it("asks the send's own approver before the deps' one", async () => {
    const { deps, approveCommand } = await setUp(false);
    const own = vi.fn(() => Promise.resolve(true));
    const summary = await sendThroughEngine(deps, 'send-4', 'q-echo', {
      draft: { kind: 'mcp' },
      approveCommand: own,
    });
    expect(summary.result).toMatchObject({ content: [{ text: 'saved' }] });
    expect(own).toHaveBeenCalledTimes(1);
    expect(approveCommand).not.toHaveBeenCalled();
  });

  it('sends a sequence step or a Runner request as saved', () => {
    expect(draftFor('mcp')).toEqual({ kind: 'mcp' });
  });
});
