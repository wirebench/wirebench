// @vitest-environment node
/**
 * This machine's MCP stdio approvals (#79): the store in `userData/mcp-approvals.json`, and the
 * prompt's round trip to a window that answers *Run once*, *Always allow* or *Cancel*.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandApprovalRequest } from '@wirebench/engine';
import { MCP_APPROVALS_FILE, McpApprovals, McpApprovalStore, type McpPromptWindow } from '../src/mcp-approvals.js';
import type { McpApprovalAnswerWire, McpApprovalPromptEvent } from '@wirebench/wire/kinds/mcp/wire';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wirebench-mcp-approvals-'));
  file = join(dir, MCP_APPROVALS_FILE);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = (fingerprint = 'fp-1'): CommandApprovalRequest => ({
  fingerprint,
  display: 'node server.mjs --token ${secret:t}',
  cwd: '/work/project',
  envNames: ['API_KEY'],
  serverName: 'Local files',
});

/** A window that records every prompt and answers it as `answer` says (or not at all). */
function mockWindow(answer?: (event: McpApprovalPromptEvent) => McpApprovalAnswerWire | undefined) {
  const prompts: McpApprovalPromptEvent[] = [];
  let gone: (() => void) | undefined;
  let approvals: McpApprovals | undefined;
  const window: McpPromptWindow = {
    prompt: (event) => {
      prompts.push(event);
      const chosen = answer?.(event);
      if (chosen !== undefined) queueMicrotask(() => approvals?.answer(event.promptId, chosen));
      return true;
    },
    onGone: (listener) => {
      gone = listener;
      return () => {
        gone = undefined;
      };
    },
  };
  return {
    window,
    prompts,
    close: () => gone?.(),
    bind: (bound: McpApprovals) => {
      approvals = bound;
    },
  };
}

describe('the approval store', () => {
  it('lists nothing for a missing file, keeps approvals newest first, and revokes one', async () => {
    const store = new McpApprovalStore(file);
    expect(await store.list()).toEqual([]);
    await store.add({ fingerprint: 'a', display: 'node a', serverName: 'A', approvedAt: '2026-10-01T00:00:00.000Z' });
    await store.add({ fingerprint: 'b', display: 'node b', approvedAt: '2026-10-02T00:00:00.000Z' });
    expect((await store.list()).map((approval) => approval.fingerprint)).toEqual(['b', 'a']);
    expect(await store.has('a')).toBe(true);

    expect((await store.revoke('b')).map((approval) => approval.fingerprint)).toEqual(['a']);
    expect(await store.has('b')).toBe(false);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as unknown;
    expect(onDisk).toEqual({
      version: 1,
      approvals: [{ fingerprint: 'a', display: 'node a', serverName: 'A', approvedAt: '2026-10-01T00:00:00.000Z' }],
    });
    // Written atomically: no temporary file is left beside it.
    expect(await readdir(dir)).toEqual([MCP_APPROVALS_FILE]);
  });

  it('lands two approvals made at once, and reads a malformed file as none, once reported', async () => {
    const store = new McpApprovalStore(file);
    await Promise.all([
      store.add({ fingerprint: 'a', display: 'a', approvedAt: '2026-10-01T00:00:00.000Z' }),
      store.add({ fingerprint: 'b', display: 'b', approvedAt: '2026-10-02T00:00:00.000Z' }),
    ]);
    expect(await store.list()).toHaveLength(2);

    await writeFile(file, '{ not json');
    const log = vi.fn();
    const broken = new McpApprovalStore(file, log);
    expect(await broken.list()).toEqual([]);
    expect(await broken.has('a')).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('the approval prompt', () => {
  const now = () => new Date('2026-10-14T10:00:00.000Z');

  it('passes an approved fingerprint without asking', async () => {
    const store = new McpApprovalStore(file);
    await store.add({ fingerprint: 'fp-1', display: 'x', approvedAt: '2026-10-01T00:00:00.000Z' });
    const mock = mockWindow(() => 'once');
    const approvals = new McpApprovals({ store });
    expect(await approvals.approver(mock.window)(request())).toBe(true);
    expect(mock.prompts).toEqual([]);
  });

  it('asks the window, and Run once lets the send through without keeping it', async () => {
    const store = new McpApprovalStore(file);
    const mock = mockWindow(() => 'once');
    const approvals = new McpApprovals({ store, newId: () => 'p-1' });
    mock.bind(approvals);
    expect(await approvals.approver(mock.window)(request())).toBe(true);
    expect(mock.prompts).toEqual([
      {
        promptId: 'p-1',
        serverName: 'Local files',
        fingerprint: 'fp-1',
        display: 'node server.mjs --token ${secret:t}',
        cwd: '/work/project',
        envNames: ['API_KEY'],
      },
    ]);
    expect(await store.list()).toEqual([]);
  });

  it('keeps an Always allow, so the next send does not ask', async () => {
    const store = new McpApprovalStore(file);
    const mock = mockWindow(() => 'always');
    const approvals = new McpApprovals({ store, now });
    mock.bind(approvals);
    expect(await approvals.approver(mock.window)(request())).toBe(true);
    expect(await approvals.list()).toEqual([
      {
        fingerprint: 'fp-1',
        display: 'node server.mjs --token ${secret:t}',
        serverName: 'Local files',
        approvedAt: '2026-10-14T10:00:00.000Z',
      },
    ]);
    expect(await approvals.approver(mock.window)(request())).toBe(true);
    expect(mock.prompts).toHaveLength(1);
    // Revoked, it asks again.
    await approvals.revoke('fp-1');
    expect(await approvals.approver(mock.window)(request())).toBe(true);
    expect(mock.prompts).toHaveLength(2);
  });

  it('refuses on Cancel, when the window goes away, when nobody answers, and with no window', async () => {
    const store = new McpApprovalStore(file);
    const cancel = mockWindow(() => 'cancel');
    const approvals = new McpApprovals({ store });
    cancel.bind(approvals);
    expect(await approvals.approver(cancel.window)(request())).toBe(false);

    const closing = mockWindow();
    const asking = approvals.approver(closing.window)(request());
    await vi.waitFor(() => {
      expect(closing.prompts).toHaveLength(1);
    });
    closing.close();
    expect(await asking).toBe(false);

    const silent = mockWindow();
    const unanswered = new McpApprovals({ store, timeoutMs: 20 });
    expect(await unanswered.approver(silent.window)(request())).toBe(false);
    expect(silent.prompts).toHaveLength(1);

    expect(await new McpApprovals({ store }).approver()(request())).toBe(false);
    const gone: McpPromptWindow = { prompt: () => false, onGone: () => () => undefined };
    expect(await approvals.approver(gone)(request())).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('ignores an answer to a prompt nobody is waiting on', () => {
    const approvals = new McpApprovals({ store: new McpApprovalStore(file) });
    expect(() => {
      approvals.answer('nope', 'always');
    }).not.toThrow();
  });

  it('asks once per fingerprint in a run, whatever the answer was', async () => {
    const store = new McpApprovalStore(file);
    const mock = mockWindow((event) => (event.fingerprint === 'fp-1' ? 'once' : 'cancel'));
    const approvals = new McpApprovals({ store, defaultWindow: () => mock.window });
    mock.bind(approvals);
    const run = approvals.forRun();
    expect(await Promise.all([run(request('fp-1')), run(request('fp-1'))])).toEqual([true, true]);
    expect(await run(request('fp-2'))).toBe(false);
    expect(await run(request('fp-2'))).toBe(false);
    expect(await run(request('fp-1'))).toBe(true);
    expect(mock.prompts.map((event) => event.fingerprint)).toEqual(['fp-1', 'fp-2']);
    // A new run asks again: Run once kept nothing.
    expect(await approvals.forRun()(request('fp-1'))).toBe(true);
    expect(mock.prompts).toHaveLength(3);
  });
});
