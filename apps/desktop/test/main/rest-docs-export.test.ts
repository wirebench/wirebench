// @vitest-environment node
/**
 * `api.exportDocs` (API Overview §3.3): main builds the API's documentation from the open project,
 * proposes a file name, and writes only what the Save dialog returned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, createProject, createRestRequest, entry, withRestApis, type Project } from '@wirebench/engine';
import { apiDocsFile, registerRestDocsChannels } from '../../src/main/kinds/rest/docs-export.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

type Envelope = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

function invoke(channel: string, payload: unknown): Promise<Envelope> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler({ sender: { id: 1 } }, payload) as Promise<Envelope>;
}

const API = createApi('Cards / v1', {
  id: 'A1',
  baseUrl: 'https://cards.test',
  description: 'Issue **cards**. <script>alert(1)</script>',
  auth: { type: 'bearer', token: '${secret:token}' },
  requests: [
    createRestRequest('Issue', {
      method: 'POST',
      url: '${base_url}/cards',
      headers: [entry('Authorization', 'Bearer ${secret:token}')],
    }),
  ],
});
const PROJECT: Project = withRestApis(createProject('CaaS', { id: 'P1' }), [API]);

let written: { path: string; text: string }[];
let pickSave: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  written = [];
  pickSave = vi.fn().mockResolvedValue('/tmp/out/docs.html');
  registerRestDocsChannels({
    router: {
      projectId: (id) => (id === 'A1' ? 'P1' : undefined),
      hostFor: () => ({ open: { project: PROJECT } }),
    },
    picks: { rememberWrite: vi.fn() },
    pickSave: pickSave as never,
    write: (path, text) => {
      written.push({ path, text });
      return Promise.resolve();
    },
  });
});

describe('apiDocsFile', () => {
  it('builds HTML or Markdown and a file name the OS accepts', () => {
    const html = apiDocsFile(PROJECT, 'A1', 'html');
    expect(html.fileName).toBe('Cards - v1.html');
    expect(html.text).toContain('<h1>Cards / v1</h1>');
    expect(html.text).toContain('Auth: Bearer token');
    expect(html.text).not.toContain('<script>');

    const markdown = apiDocsFile(PROJECT, 'A1', 'markdown');
    expect(markdown.fileName).toBe('Cards - v1.md');
    expect(markdown.text).toContain('`Bearer ${secret:token}`');
  });

  it('refuses an id that is not a REST API of the project', () => {
    expect(() => apiDocsFile(PROJECT, 'nope', 'html')).toThrow(/No REST API/);
  });
});

describe('api.exportDocs', () => {
  it('writes the document where the Save dialog points', async () => {
    await expect(invoke('api.exportDocs', { apiId: 'A1', format: 'html' })).resolves.toEqual({
      ok: true,
      value: { cancelled: false, path: '/tmp/out/docs.html' },
    });
    expect(pickSave).toHaveBeenCalledWith(
      { id: 1 },
      expect.anything(),
      expect.objectContaining({ defaultPath: 'Cards - v1.html' }),
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.text.startsWith('<!doctype html>')).toBe(true);
  });

  it('writes nothing when the dialog is cancelled', async () => {
    pickSave.mockResolvedValue(undefined);
    await expect(invoke('api.exportDocs', { apiId: 'A1', format: 'markdown' })).resolves.toEqual({
      ok: true,
      value: { cancelled: true },
    });
    expect(written).toEqual([]);
  });

  it('refuses an unknown API before asking for a path', async () => {
    await expect(invoke('api.exportDocs', { apiId: 'gone', format: 'html' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(pickSave).not.toHaveBeenCalled();
  });

  it('refuses a format it does not know', async () => {
    await expect(invoke('api.exportDocs', { apiId: 'A1', format: 'pdf' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
  });
});
