import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const project: ProjectWire = {
  ...NO_REST,
  settings: PROJECT_SETTINGS,
  id: 'proj-1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  disabledProperties: [],
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

const inspectHttpFile = vi.fn();
const importHttpFile = vi.fn();
const importHttpEnv = vi.fn();

function httpFileResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      projectId: 'proj-1',
      project,
      apiIds: ['a1'],
      counts: { requests: 2, websocket: 0, skipped: 0, scripts: 0 },
      warnings: [],
      notes: [],
      reportText: '',
      ...overrides,
    },
  };
}

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  inspectHttpFile.mockReset().mockResolvedValue({ ok: true, value: { environments: [] } });
  importHttpFile.mockReset().mockResolvedValue(httpFileResponse());
  importHttpEnv.mockReset().mockResolvedValue({
    ok: true,
    value: {
      summary: { environments: [{ name: 'dev', variables: 2 }], secretsStored: 1, warnings: [], notes: [] },
      reportText: '',
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — .http file', () => {
  it('offers the environments found beside the file and passes the choice', async () => {
    inspectHttpFile.mockResolvedValue({ ok: true, value: { environments: ['dev', 'prod'] } });
    installWirebenchApi({ api: { inspectHttpFile, importHttpFile } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-file" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/api.http' } });
    expect(await screen.findByText('Also import 2 environments found beside the file (dev, prod)')).toBeTruthy();
    expect(inspectHttpFile).toHaveBeenCalledWith({ path: '/work/api.http' });
    expect(screen.getByTestId<HTMLInputElement>('import-http-include-envs').checked).toBe(true);
    fireEvent.click(screen.getByTestId('import-http-include-envs'));
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importHttpFile).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/api.http' },
        includeEnvironments: false,
      }),
    );
  });

  it('asks once the path settles, and drops a reply for a path that has moved on', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    inspectHttpFile
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, value: { environments: ['staging'] } });
    installWirebenchApi({ api: { inspectHttpFile, importHttpFile } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-file" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/old.http' } });
    await waitFor(() => expect(inspectHttpFile).toHaveBeenCalledWith({ path: '/work/old.http' }));
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/new.http' } });
    expect(await screen.findByText('Also import 1 environment found beside the file (staging)')).toBeTruthy();
    answerFirst({ ok: true, value: { environments: ['dev', 'prod'] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/dev, prod/)).toBeNull();
    expect(inspectHttpFile).toHaveBeenCalledTimes(2);
  });

  it('shows no checkbox when nothing sits beside the file, and sends pasted text', async () => {
    installWirebenchApi({ api: { inspectHttpFile, importHttpFile } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-file" />);
    expect(screen.queryByRole('tab', { name: 'URL' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: 'GET https://example.com/a' } });
    expect(screen.queryByTestId('import-http-include-envs')).toBeNull();
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importHttpFile).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'text', text: 'GET https://example.com/a' },
        includeEnvironments: false,
      }),
    );
    expect(inspectHttpFile).not.toHaveBeenCalled();
  });

  it('summarises the counts, the environments added and the report', async () => {
    importHttpFile.mockResolvedValue(
      httpFileResponse({
        counts: { requests: 3, websocket: 1, skipped: 1, scripts: 2 },
        variables: {
          environments: [
            { name: 'dev', variables: 2 },
            { name: 'prod 2', renamedFrom: 'prod', variables: 1 },
          ],
          projectProperties: { added: 1, skipped: [] },
          secretsStored: 1,
          warnings: [],
          notes: [],
        },
        warnings: ['The GRPC request at line 9 was skipped: a gRPC request needs a definition; import its .proto.'],
        notes: ['One: the response handler was saved to imported-scripts/api/one.handler.js and is never run.'],
        reportText: 'Warning: …',
      }),
    );
    installWirebenchApi({ api: { inspectHttpFile, importHttpFile } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-file" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/api.http' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    const summary = await screen.findByTestId('import-http-summary');
    expect(importHttpFile).toHaveBeenCalledWith({
      target: { projectId: 'proj-1' },
      source: { kind: 'file', path: '/work/api.http' },
      includeEnvironments: false,
    });
    expect(screen.getByTestId('import-http-counts').textContent).toBe(
      '3 requests, 1 WebSocket request, 1 skipped, 2 handlers kept in imported-scripts/',
    );
    expect(summary.textContent).toContain('dev (2 variables)');
    expect(summary.textContent).toContain('prod 2 (1 variable)');
    expect(summary.textContent).toContain('was prod');
    expect(summary.textContent).toContain('1 project property added');
    expect(summary.textContent).toContain('1 secret stored');
    expect(screen.getByTestId('import-http-summary-warnings').textContent).toContain('GRPC');
    expect(screen.getByTestId('import-http-summary-notes').textContent).toContain('handler');
    expect(screen.getByTestId('import-http-summary-copy-report')).toBeTruthy();
  });

  it('asks for no environments when none were found beside the file', async () => {
    installWirebenchApi({ api: { inspectHttpFile, importHttpFile } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-file" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/api.http' } });
    await waitFor(() => expect(inspectHttpFile).toHaveBeenCalledWith({ path: '/work/api.http' }));
    expect(screen.queryByTestId('import-http-include-envs')).toBeNull();
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importHttpFile).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/api.http' },
        includeEnvironments: false,
      }),
    );
  });

  it.each([
    [
      'refused',
      () =>
        inspectHttpFile.mockResolvedValue({
          ok: false,
          error: { code: 'import-path-refused', message: 'http-client.env.json is a symbolic link' },
        }),
    ],
    ['rejected', () => inspectHttpFile.mockRejectedValue(new Error('http-client.env.json is a symbolic link'))],
  ])(
    'says why the environment files were not read when the inspection is %s, and imports without them',
    async (_label, arrange) => {
      arrange();
      installWirebenchApi({ api: { inspectHttpFile, importHttpFile } });
      render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-file" />);
      fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/api.http' } });
      expect((await screen.findByTestId('import-http-envs-error')).textContent).toBe(
        'The environment files beside it were not read: http-client.env.json is a symbolic link',
      );
      expect(screen.queryByTestId('import-http-include-envs')).toBeNull();
      fireEvent.click(screen.getByTestId('import-submit'));
      await waitFor(() =>
        expect(importHttpFile).toHaveBeenCalledWith({
          target: { projectId: 'proj-1' },
          source: { kind: 'file', path: '/work/api.http' },
          includeEnvironments: false,
        }),
      );
    },
  );

  it('shows the refusal main answers with', async () => {
    importHttpFile.mockResolvedValue({
      ok: false,
      error: { code: 'http-file-too-many', message: 'The file holds more than 5,000 requests' },
    });
    installWirebenchApi({ api: { inspectHttpFile, importHttpFile } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-file" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/big.http' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    expect((await screen.findByRole('alert')).textContent).toBe('The file holds more than 5,000 requests');
  });
});

describe('Import dialog — HTTP client environment file', () => {
  it('imports an environment file on its own without a project picker', () => {
    installWirebenchApi({ api: { importHttpEnv } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-env" />);
    expect(screen.queryByTestId('import-target-project')).toBeNull();
  });

  it('sends the picked file and shows the environments it made', async () => {
    installWirebenchApi({ api: { importHttpEnv } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-env" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/http-client.env.json' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importHttpEnv).toHaveBeenCalledWith({ source: { kind: 'file', path: '/work/http-client.env.json' } }),
    );
    const summary = await screen.findByTestId('import-variables-summary');
    expect(summary.textContent).toContain('dev (2 variables)');
    expect(summary.textContent).toContain('1 secret stored');
  });

  it('sends pasted JSON as the environment file text', async () => {
    installWirebenchApi({ api: { importHttpEnv } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-env" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: '{"dev":{"host":"x"}}' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importHttpEnv).toHaveBeenCalledWith({ source: { kind: 'text', text: '{"dev":{"host":"x"}}' } }),
    );
    expect(await screen.findByTestId('import-variables-summary')).toBeTruthy();
  });
});
