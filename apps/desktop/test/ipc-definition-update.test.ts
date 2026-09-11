// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
import { registerDefinitionChannels } from '../src/main/ipc/definition.js';
import type { DefinitionChannelProject } from '../src/main/ipc/definition.js';
import type {
  ApplyUpdateWire,
  DefinitionExportResponse,
  DefinitionGenerateDocsResponse,
  ProjectWire,
  UpdatePlanWire,
} from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

async function ok<T>(channel: string, payload: unknown): Promise<T> {
  const result = (await invoke(channel, payload)) as { ok: boolean; value: T; error?: { message: string } };
  expect(result.ok, result.error?.message).toBe(true);
  return result.value;
}

async function failure(channel: string, payload: unknown): Promise<string> {
  const result = (await invoke(channel, payload)) as { ok: boolean; error: { message: string } };
  expect(result.ok).toBe(false);
  return result.error.message;
}

const EMPTY_PLAN: UpdatePlanWire = {
  newOperations: [{ bindingName: '{urn:x}B', operationName: 'Subtract' }],
  removedOperations: [],
  changedOperations: [{ ref: { bindingName: '{urn:x}B', operationName: 'Echo' }, reason: 'input-schema' }],
  endpointsAdded: [],
  endpointsRemoved: [],
};

const SNAPSHOT = {
  id: 'p1',
  name: 'P',
  dir: '/tmp/p',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  environments: [],
  problems: [],
  settings: { cacheDefinitions: true, defaultTimeoutMs: 1000, prettyPrintResponses: true },
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
} as unknown as ProjectWire;

/** A recording stand-in for `ProjectService`, so the channels are tested, not the project. */
function stubProject(overrides: Partial<DefinitionChannelProject> = {}): DefinitionChannelProject & {
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    planDefinitionUpdate: (interfaceId, source) => {
      calls.push({ kind: 'plan', interfaceId, source });
      return Promise.resolve(EMPTY_PLAN);
    },
    applyDefinitionUpdate: (interfaceId, source, options) => {
      calls.push({ kind: 'apply', interfaceId, source, options });
      return Promise.resolve({
        plan: EMPTY_PLAN,
        requestsCreated: ['r1'],
        requestsRecreated: ['r2'],
        requestsOrphaned: [],
        backups: ['interfaces/a/operations/echo/request-1.xml.bak'],
      });
    },
    exportDefinitionTo: (interfaceId, dir) => {
      calls.push({ kind: 'export', interfaceId, dir });
      return Promise.resolve(['service.wsdl']);
    },
    definitionDocs: (interfaceId, format) => {
      calls.push({ kind: 'docs', interfaceId, format });
      return format === 'html' ? '<!DOCTYPE html><p>doc</p>' : '# doc';
    },
    snapshot: () => SNAPSHOT,
    ...overrides,
  };
}

let tmp = '';

beforeEach(() => {
  handlers.clear();
  tmp = mkdtempSync(join(tmpdir(), 'wirebench-docs-'));
  delete process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
  delete process.env['WIREBENCH_E2E_DIALOG_SAVE'];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
  delete process.env['WIREBENCH_E2E_DIALOG_SAVE'];
});

describe('definition.* update, export and docs IPC', () => {
  it('passes the source through to planDefinitionUpdate and returns its plan', async () => {
    const project = stubProject();
    registerDefinitionChannels(new EngineService(), { project, picks: { rememberWrite: () => undefined } });
    const plan = await ok<UpdatePlanWire>('definition.planUpdate', {
      interfaceId: 'if-1',
      source: { kind: 'url', url: 'http://example.invalid/x.wsdl' },
    });
    expect(plan.newOperations[0]?.operationName).toBe('Subtract');
    expect(project.calls).toEqual([
      { kind: 'plan', interfaceId: 'if-1', source: { kind: 'url', url: 'http://example.invalid/x.wsdl' } },
    ]);
  });

  it('rejects a source that is neither a URL nor a file path', async () => {
    registerDefinitionChannels(new EngineService(), {
      project: stubProject(),
      picks: { rememberWrite: () => undefined },
    });
    expect(
      await failure('definition.planUpdate', { interfaceId: 'if-1', source: { kind: 'text', text: '<wsdl/>' } }),
    ).toMatch(/request/i);
  });

  it('returns the fresh project snapshot alongside what applying the update did', async () => {
    registerDefinitionChannels(new EngineService(), {
      project: stubProject(),
      picks: { rememberWrite: () => undefined },
    });
    const applied = await ok<ApplyUpdateWire>('definition.applyUpdate', {
      interfaceId: 'if-1',
      source: { kind: 'file', path: '/tmp/new.wsdl' },
      options: {
        createNewRequests: true,
        recreateRequests: true,
        recreateOptional: false,
        keepExisting: true,
        keepSoapHeaders: true,
        createBackups: true,
        updateTestRequests: false,
      },
    });
    expect(applied.requestsCreated).toEqual(['r1']);
    expect(applied.project.id).toBe('p1');
  });

  it('reports a cancelled folder picker instead of exporting', async () => {
    const project = stubProject();
    registerDefinitionChannels(new EngineService(), { project, picks: { rememberWrite: () => undefined } });
    const result = await ok<DefinitionExportResponse>('definition.export', { interfaceId: 'if-1' });
    expect(result).toEqual({ cancelled: true, files: [] });
    expect(project.calls).toEqual([]);
  });

  it('exports into the folder the picker answers with', async () => {
    process.env['WIREBENCH_E2E_DIALOG_FOLDER'] = tmp;
    const project = stubProject();
    registerDefinitionChannels(new EngineService(), { project, picks: { rememberWrite: () => undefined } });
    const result = await ok<DefinitionExportResponse>('definition.export', { interfaceId: 'if-1' });
    expect(result).toEqual({ cancelled: false, dir: tmp, files: ['service.wsdl'] });
    expect(project.calls).toEqual([{ kind: 'export', interfaceId: 'if-1', dir: tmp }]);
  });

  it('writes the rendered documentation to the picked path and records the write pick', async () => {
    const target = join(tmp, 'docs.html');
    process.env['WIREBENCH_E2E_DIALOG_SAVE'] = target;
    const picked: string[] = [];
    registerDefinitionChannels(new EngineService(), {
      project: stubProject(),
      picks: { rememberWrite: (path) => picked.push(path) },
    });
    const result = await ok<DefinitionGenerateDocsResponse>('definition.generateDocs', {
      interfaceId: 'if-1',
      format: 'html',
    });
    expect(result).toEqual({ cancelled: false, path: target });
    expect(await readFile(target, 'utf8')).toContain('<p>doc</p>');
    expect(picked).toEqual([target]);
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    registerDefinitionChannels(new EngineService(), {
      project: stubProject(),
      picks: { rememberWrite: () => undefined },
    });
    const result = await ok<DefinitionGenerateDocsResponse>('definition.generateDocs', {
      interfaceId: 'if-1',
      format: 'markdown',
    });
    expect(result).toEqual({ cancelled: true });
  });

  it('registers only the read-only channels when no project deps are given', () => {
    registerDefinitionChannels(new EngineService());
    expect(handlers.has('definition.documents')).toBe(true);
    expect(handlers.has('definition.planUpdate')).toBe(false);
  });
});
