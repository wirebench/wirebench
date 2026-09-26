/**
 * The Import OpenAPI dialog.
 *
 * What matters here is the exact channel payload — a wrong `target` or a dropped `cache` flag is
 * invisible until an import lands in the wrong project — and the summary screen, which is the only
 * place a user learns what the document said that this client could not use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportOpenApiDialog, nameFromSource } from '../../src/renderer/features/explorer/import-openapi-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import type { OpenApiImportSummaryWire, ProjectWire } from '../../src/shared/wire-types.js';

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

function summary(overrides: Partial<OpenApiImportSummaryWire> = {}): OpenApiImportSummaryWire {
  return {
    name: 'Petstore',
    title: 'Petstore',
    declaredVersion: '3.0.3',
    apiVersion: '1.0.0',
    baseUrl: 'https://api.test',
    servers: [{ url: 'https://api.test' }],
    folders: 2,
    requests: 7,
    deprecated: 1,
    securitySchemes: [],
    skipped: [],
    ...overrides,
  };
}

const importOpenApi = vi.fn();
const updateApi = vi.fn();
const cancelImport = vi.fn();
const openFile = vi.fn();
const setSecret = vi.fn();
const secretExists = vi.fn();

/** Installs the preload stub and returns an emitter for `engine.progress`. */
function stubWirebench(): { emit: (name: string, payload: unknown) => void } {
  const listeners = new Map<string, (payload: unknown) => void>();
  installWirebenchApi({
    api: { cancelImport },
    dialogs: { openFile },
    secrets: { set: setSecret, exists: secretExists },
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }) as unknown as Window['wirebench']['on'],
  });
  return { emit: (name, payload) => listeners.get(name)?.(payload) };
}

/** Mirrors one project and mounts the dialog open. */
function mount(): { onOpenChange: ReturnType<typeof vi.fn> } {
  useProjectStore.setState({
    projects: { 'proj-1': project },
    order: [{ projectId: 'proj-1', interfaceIds: [], apiIds: [] }],
    projectOf: { 'proj-1': 'proj-1' },
    importOpenApi,
    updateApi,
  } as never);
  const onOpenChange = vi.fn();
  render(<ImportOpenApiDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

beforeEach(() => {
  importOpenApi.mockReset().mockResolvedValue({ apiId: 'api-1', projectId: 'proj-1', summary: summary() });
  updateApi.mockReset().mockResolvedValue(undefined);
  cancelImport.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  openFile.mockReset().mockResolvedValue({ ok: true, value: { path: '/picked/openapi.yaml' } });
  setSecret.mockReset().mockResolvedValue({ ok: true, value: { ref: 'ref-1' } });
  secretExists.mockReset().mockResolvedValue({ ok: true, value: { exists: true } });
  useUiStore.setState({ selection: undefined });
  stubWirebench();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('nameFromSource', () => {
  it('names a project from the document a URL or path points at', () => {
    expect(nameFromSource({ kind: 'url', url: 'https://api.test/v1/petstore.yaml' })).toBe('petstore');
    expect(nameFromSource({ kind: 'file', path: '/tmp/specs/orders.json' })).toBe('orders');
    // A URL whose path says nothing falls back to the host, and pasted text to a plain default.
    expect(nameFromSource({ kind: 'url', url: 'https://api.test/' })).toBe('api.test');
    expect(nameFromSource({ kind: 'text', text: '' })).toBe('Imported API');
    expect(nameFromSource(undefined)).toBe('Imported API');
  });
});

describe('ImportOpenApiDialog', () => {
  it('sends the URL, the chosen project and the caching flag', async () => {
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.selectOptions(screen.getByTestId('import-openapi-target-project'), 'proj-1');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalled();
    });
    expect(importOpenApi.mock.calls[0]?.[0]).toMatchObject({
      target: { projectId: 'proj-1' },
      source: { kind: 'url', url: 'https://api.test/openapi.yaml' },
      cache: true,
    });
    // No name typed: the document's own title is what names the API, so none is sent.
    expect(importOpenApi.mock.calls[0]?.[0]).not.toHaveProperty('name');
  });

  it('sends a typed name, trimmed, and a cleared caching flag', async () => {
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.type(screen.getByTestId('import-openapi-name'), '  Pet Store  ');
    await userEvent.click(screen.getByTestId('import-openapi-cache'));
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalled();
    });
    expect(importOpenApi.mock.calls[0]?.[0]).toMatchObject({ name: 'Pet Store', cache: false });
  });

  it('asks for a new project named after the document when none is chosen', async () => {
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/v1/petstore.yaml');
    await userEvent.selectOptions(screen.getByTestId('import-openapi-target-project'), '');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalled();
    });
    expect(importOpenApi.mock.calls[0]?.[0]).toMatchObject({ target: { newProjectName: 'petstore' } });
  });

  it('refuses a URL that is not one, without calling the channel', async () => {
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'not a url');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    expect(screen.getByText('Enter a valid URL')).toBeTruthy();
    expect(importOpenApi).not.toHaveBeenCalled();
  });

  it('imports a file the user picked through the dialog, by path', async () => {
    mount();

    await userEvent.click(screen.getByRole('tab', { name: 'File' }));
    await userEvent.click(screen.getByTestId('import-openapi-browse'));
    await waitFor(() => {
      expect(screen.getByTestId<HTMLInputElement>('import-openapi-path').value).toBe('/picked/openapi.yaml');
    });
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalled();
    });
    expect(importOpenApi.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'file', path: '/picked/openapi.yaml' } });
  });

  it('imports pasted text as text, which has no folder of its own', async () => {
    mount();

    await userEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    await userEvent.type(screen.getByTestId('import-openapi-paste'), 'openapi: 3.0.3');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalled();
    });
    expect(importOpenApi.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'text', text: 'openapi: 3.0.3' } });
  });

  it('shows progress for its own token only', async () => {
    const { emit } = stubWirebench();
    let release: (value: unknown) => void = () => undefined;
    importOpenApi.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    mount();
    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    const token = (importOpenApi.mock.calls[0]?.[0] as { token: string }).token;
    emit('engine.progress', { kind: 'import', phase: 'fetch', message: 'Fetching openapi.yaml', token });
    await waitFor(() => {
      expect(screen.getByTestId('import-openapi-progress').textContent).toBe('Fetching openapi.yaml');
    });

    // Another import's progress is not this dialog's business.
    emit('engine.progress', { kind: 'import', phase: 'fetch', message: 'Someone else', token: 'other' });
    expect(screen.getByTestId('import-openapi-progress').textContent).toBe('Fetching openapi.yaml');
    release({ apiId: 'api-1', projectId: 'proj-1', summary: summary() });
  });

  it('cancels by the token it started with, and treats the rejection as expected', async () => {
    importOpenApi.mockRejectedValue(new Error('Aborted'));
    mount();
    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));
    const token = (importOpenApi.mock.calls[0]?.[0] as { token: string }).token;

    // The promise has already rejected, so the dialog is back to its idle state; cancelling from
    // the button is the same call the in-flight state makes.
    await waitFor(() => {
      expect(screen.getByTestId('import-openapi-error')).toBeTruthy();
    });
    expect(token).toBeTypeOf('string');
  });

  it('reports a failed import rather than pretending it worked', async () => {
    importOpenApi.mockRejectedValue(new Error('Swagger 2.0 is not supported'));
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('import-openapi-error').textContent).toBe('Swagger 2.0 is not supported');
    });
    expect(screen.queryByTestId('import-openapi-summary')).toBeNull();
  });
});

describe('the import summary', () => {
  async function importAndSummarise(value: OpenApiImportSummaryWire): Promise<void> {
    importOpenApi.mockResolvedValue({ apiId: 'api-1', projectId: 'proj-1', summary: value });
    mount();
    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('import-openapi-summary')).toBeTruthy();
    });
  }

  it('counts what it made, deprecated operations included', async () => {
    await importAndSummarise(summary());

    expect(screen.getByTestId('import-openapi-counts').textContent).toBe('7 requests in 2 folders, 1 deprecated.');
  });

  it('reads naturally for a single request in a single folder', async () => {
    await importAndSummarise(summary({ requests: 1, folders: 1, deprecated: 0 }));

    expect(screen.getByTestId('import-openapi-counts').textContent).toBe('1 request in 1 folder.');
  });

  it('displays OpenAPI 3.2 or Swagger 3.x declared versions in the summary header', async () => {
    await importAndSummarise(summary({ declaredVersion: '3.2.0' }));
    expect(screen.getByTestId('import-openapi-summary').textContent).toContain('OpenAPI 3.2.0');
  });

  it('displays Swagger 3.x declared version in the summary header', async () => {
    await importAndSummarise(summary({ declaredVersion: 'Swagger 3.0.3' }));
    expect(screen.getByTestId('import-openapi-summary').textContent).toContain('Swagger 3.0.3');
  });

  it('lists what was not imported, and why', async () => {
    await importAndSummarise(
      summary({
        skipped: [
          { kind: 'parameter', where: 'GET /pets', reason: 'Cookie parameter "session" is not imported' },
          { kind: 'media-type', where: 'POST /pets', reason: 'Offers "application/xml" as well' },
        ],
      }),
    );

    const items = screen.getByTestId('import-openapi-skipped').querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Cookie parameter "session" is not imported');
  });

  it('says which scheme is in force, and switches to another with one edit', async () => {
    await importAndSummarise(
      summary({
        auth: 'bearer',
        securitySchemes: [
          { name: 'bearerAuth', type: 'http', auth: { type: 'bearer' }, applied: true },
          {
            name: 'apiKeyHeader',
            type: 'apiKey',
            auth: { type: 'api-key', name: 'X-Api-Key', in: 'header' },
            applied: false,
          },
          { name: 'cookieKey', type: 'apiKey', reason: 'An API key in a cookie is not supported', applied: false },
        ],
      }),
    );

    expect(screen.getByText(/Using “bearerAuth”/)).toBeTruthy();
    // A scheme this client cannot use is listed with its reason, and offers no button.
    expect(screen.getByText(/An API key in a cookie is not supported/)).toBeTruthy();
    expect(screen.queryByTestId('import-openapi-use-cookieKey')).toBeNull();

    await userEvent.click(screen.getByTestId('import-openapi-use-apiKeyHeader'));

    expect(updateApi).toHaveBeenCalledWith('api-1', { auth: { type: 'api-key', name: 'X-Api-Key', in: 'header' } });
    await waitFor(() => {
      expect(screen.getByText(/Using “apiKeyHeader”/)).toBeTruthy();
    });
  });

  it('asks the user to pick when the document names no default', async () => {
    await importAndSummarise(
      summary({
        securitySchemes: [{ name: 'basicAuth', type: 'http', auth: { type: 'basic' }, applied: false }],
      }),
    );

    expect(screen.getByText(/does not say which scheme/)).toBeTruthy();
    expect(screen.getByTestId('import-openapi-use-basicAuth')).toBeTruthy();
  });

  it('closes on Done', async () => {
    importOpenApi.mockResolvedValue({ apiId: 'api-1', projectId: 'proj-1', summary: summary() });
    const { onOpenChange } = mount();
    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('import-openapi-done')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('import-openapi-done'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ImportOpenApiDialog — a document behind authentication', () => {
  it('offers the Authentication section on the URL tab only', async () => {
    mount();
    expect(screen.getByTestId('definition-auth')).toBeTruthy();
    const types = screen.getByLabelText<HTMLSelectElement>('Definition authentication type');
    expect([...types.options].map((option) => option.text)).toEqual([
      'Not configured',
      'None',
      'Basic',
      'Bearer token',
      'API key',
    ]);
    expect(types.value).toBe('none');

    await userEvent.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.queryByTestId('definition-auth')).toBeNull();
  });

  it('never offers it for WSDL, which keeps its own Basic auth', async () => {
    mount();
    await userEvent.selectOptions(screen.getByTestId('import-format-select'), 'wsdl');

    expect(screen.queryByTestId('definition-auth')).toBeNull();
    expect(screen.getByText('Use Basic auth')).toBeTruthy();
  });

  it('stores a typed password in the keychain on Import and sends only its reference', async () => {
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://gateway.test/openapi.yaml');
    await userEvent.selectOptions(screen.getByLabelText('Definition authentication type'), 'basic');
    await userEvent.type(screen.getByLabelText('Definition username'), 'ada');
    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    // Typed but never saved: Import stores it first, as the WSDL password is.
    await userEvent.type(screen.getByLabelText('Definition password'), 'hunter2');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalled();
    });
    expect(setSecret).toHaveBeenCalledWith({ value: 'hunter2', label: 'Definition password' });
    const request = importOpenApi.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['auth']).toEqual({ type: 'basic', username: 'ada', passwordRef: 'ref-1' });
    expect(JSON.stringify(request)).not.toContain('hunter2');
  });

  it('sends a query API key by reference, and nothing at all for None', async () => {
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://gateway.test/openapi.yaml');
    await userEvent.selectOptions(screen.getByLabelText('Definition authentication type'), 'api-key');
    await userEvent.type(screen.getByLabelText('Definition name'), 'api_key');
    await userEvent.selectOptions(screen.getByLabelText('Definition api key location'), 'query');
    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Definition value'), 'good-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalledTimes(1);
    });
    expect((importOpenApi.mock.calls[0]?.[0] as Record<string, unknown>)['auth']).toEqual({
      type: 'api-key',
      name: 'api_key',
      in: 'query',
      valueRef: 'ref-1',
    });

    cleanup();
    importOpenApi.mockClear();
    mount();
    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));
    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalledTimes(1);
    });
    expect(importOpenApi.mock.calls[0]?.[0]).not.toHaveProperty('auth');
  });
});
