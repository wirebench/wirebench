/**
 * AsyncAPI in the unified Import dialog: the document is recognised as it is pasted, the server
 * picker appears only when there is a real choice to make, and the summary shows what the import
 * left out — the only place a user learns that a Kafka channel did not come across.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AsyncApiImportSummaryWire, ProjectWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';

// jsdom gives `import.meta.url` an http scheme, so the fixture is found from this file's directory.
const chat26 = readFileSync(
  join(dirname(import.meta.filename), '../../../../packages/engine/test/fixtures/asyncapi/chat-2.6.yaml'),
  'utf8',
);

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

const summary: AsyncApiImportSummaryWire = {
  name: 'Chat service',
  title: 'Chat service',
  declaredVersion: '2.6.0',
  server: 'public',
  servers: ['public', 'broker'],
  requests: 1,
  messages: 3,
  skipped: [{ where: 'channel audit', reason: 'kafka binding: only WebSocket is imported' }],
  unresolved: [],
  unsupportedKeywords: [],
};

const importAsyncApi = vi.fn();
const asyncApiServers = vi.fn();
const cancelImport = vi.fn();

function mount(): void {
  installWirebenchApi({
    api: { importAsyncApi, asyncApiServers, cancelImport },
    definition: { cancelImport: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }) },
    on: vi.fn(() => () => undefined) as unknown as Window['wirebench']['on'],
  });
  useProjectStore.setState({
    projects: { 'proj-1': project },
    order: [{ projectId: 'proj-1', interfaceIds: [], apiIds: [] }],
    projectOf: { 'proj-1': 'proj-1' },
  } as never);
  render(<ImportDialog open onOpenChange={vi.fn()} />);
}

beforeEach(() => {
  importAsyncApi
    .mockReset()
    .mockResolvedValue({ ok: true, value: { projectId: 'proj-1', project, apiId: 'api-1', summary } });
  asyncApiServers.mockReset().mockResolvedValue({
    ok: true,
    value: { servers: [{ key: 'public', url: 'wss://eu.chat.example.test/ws' }] },
  });
  cancelImport.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  useUiStore.setState({ selection: undefined, importDialogFormat: 'auto' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function paste(text: string): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name: 'Paste' }));
  fireEvent.change(screen.getByTestId('import-paste'), { target: { value: text } });
}

describe('ImportDialog — AsyncAPI', () => {
  it('detects the 2.6 document, imports it over the channel and lists what was skipped', async () => {
    mount();
    await paste(chat26);

    expect(screen.getByTestId('detected-format-badge').textContent).toContain('AsyncAPI 2.6.0');
    await waitFor(() => {
      expect(asyncApiServers).toHaveBeenCalledWith({ source: { kind: 'text', text: chat26 } });
    });
    // One WebSocket server is no choice at all: no picker.
    expect(screen.queryByTestId('import-asyncapi-server')).toBeNull();

    await userEvent.click(screen.getByTestId('import-submit'));

    await waitFor(() => {
      expect(importAsyncApi).toHaveBeenCalledTimes(1);
    });
    const request = importAsyncApi.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({ target: { projectId: 'proj-1' }, source: { kind: 'text', text: chat26 } });
    expect(request['server']).toBeUndefined();

    const summaryView = await screen.findByTestId('import-asyncapi-summary');
    expect(summaryView.textContent).toContain('AsyncAPI 2.6.0');
    expect(screen.getByTestId('import-asyncapi-counts').textContent).toContain('1 request, 3 messages');
    expect(screen.getByTestId('import-asyncapi-skipped').textContent).toContain(
      'channel audit — kafka binding: only WebSocket is imported',
    );
    // The mirror took the project main answered with.
    expect(useProjectStore.getState().projects['proj-1']).toBeDefined();
  });

  it('offers the WebSocket servers when there are several, first by default, and sends the choice', async () => {
    asyncApiServers.mockResolvedValue({
      ok: true,
      value: {
        servers: [
          { key: 'public', url: 'wss://eu.chat.example.test/ws' },
          { key: 'staging', url: 'wss://staging.chat.example.test/live' },
        ],
      },
    });
    mount();
    await paste(chat26);

    const picker = await screen.findByTestId('import-asyncapi-server');
    expect((picker as HTMLSelectElement).value).toBe('public');
    await userEvent.selectOptions(picker, 'staging');
    await userEvent.click(screen.getByTestId('import-submit'));

    await waitFor(() => {
      expect(importAsyncApi).toHaveBeenCalledWith(expect.objectContaining({ server: 'staging' }));
    });
  });

  it('shows the error main gives, such as an unknown server', async () => {
    importAsyncApi.mockResolvedValue({
      ok: false,
      error: { code: 'asyncapi-server-unknown', message: 'The document has no server "x"' },
    });
    mount();
    await paste(chat26);
    await waitFor(() => {
      expect(screen.getByTestId('import-submit').hasAttribute('disabled')).toBe(false);
    });
    await userEvent.click(screen.getByTestId('import-submit'));
    expect((await screen.findByRole('alert')).textContent).toContain('The document has no server "x"');
  });
  it('keeps Import disabled while the server preview is outstanding, debounce included', async () => {
    let answer: (value: unknown) => void = () => undefined;
    asyncApiServers.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    mount();
    await paste(chat26);
    // Before the debounce has even asked, an import could not know which server to dial.
    expect(screen.getByTestId('import-submit').hasAttribute('disabled')).toBe(true);
    await waitFor(() => {
      expect(asyncApiServers).toHaveBeenCalled();
    });
    expect(screen.getByTestId('import-submit').hasAttribute('disabled')).toBe(true);
    answer({ ok: true, value: { servers: [{ key: 'public', url: 'wss://eu.chat.example.test/ws' }] } });
    await waitFor(() => {
      expect(screen.getByTestId('import-submit').hasAttribute('disabled')).toBe(false);
    });
  });

  it('an older preview answering after a newer one does not replace its servers', async () => {
    const answers: ((value: unknown) => void)[] = [];
    asyncApiServers.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    mount();
    await paste(chat26);
    await waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: `${chat26}\n` } });
    await waitFor(() => {
      expect(answers).toHaveLength(2);
    });
    const servers = (keys: string[]) => ({
      ok: true,
      value: { servers: keys.map((key) => ({ key, url: `wss://${key}.example.test` })) },
    });
    answers[1]?.(servers(['newer', 'newest']));
    const picker = await screen.findByTestId('import-asyncapi-server');
    answers[0]?.(servers(['older', 'oldest']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const options = [...(picker as HTMLSelectElement).options].map((option) => option.value);
    expect(options).toEqual(['newer', 'newest']);
    expect(screen.getByTestId('import-submit').hasAttribute('disabled')).toBe(false);
  });
});
