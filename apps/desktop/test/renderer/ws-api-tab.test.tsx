/**
 * The WebSocket API tab.
 *
 * Mirrors `api-tab.test.tsx`: the URL row is what these tests are mostly about — an environment
 * override is what requests actually connect to, so the row has to say so — and the rest pins
 * that each edit sends one `update-ws-api` patch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { WsApiTab } from '../../src/renderer/features/ws-api/ws-api-tab.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import { NO_REST, PROJECT_SETTINGS, wsApiWire } from '../helpers/wire-defaults.js';
import type { EnvironmentWire, ProjectWire, WsApiWire } from '../../src/shared/wire-types.js';

const updateWsApi = vi.fn();

function project(overrides: Partial<ProjectWire> = {}): ProjectWire {
  return {
    ...NO_REST,
    settings: PROJECT_SETTINGS,
    id: 'p1',
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
    ...overrides,
  };
}

function environment(endpoints: Record<string, string>, id = 'env-1'): EnvironmentWire {
  return { id, name: 'uat', slug: 'uat', order: 0, endpoints, properties: {}, disabled: [] };
}

/** Mirrors one WebSocket API, then mounts its tab. */
function mount(api: WsApiWire = wsApiWire(), projectOverrides: Partial<ProjectWire> = {}): void {
  const wire = project({ wsApis: [api], ...projectOverrides });
  useProjectStore.setState({
    projects: { p1: wire },
    wsApis: { [api.id]: api },
    projectOf: { [api.id]: 'p1', p1: 'p1' },
    updateWsApi,
  });
  render(
    <TooltipPrimitive.Provider>
      <WsApiTab apiId={api.id} />
    </TooltipPrimitive.Provider>,
  );
}

beforeEach(() => {
  updateWsApi.mockReset().mockResolvedValue(undefined);
  installWirebenchApi();
  useWorkspaceStore.setState({ workspace: null });
});

afterEach(() => {
  cleanup();
});

describe('WsApiTab', () => {
  it('shows the name, description and URL, and says requests use it', () => {
    mount(wsApiWire({ description: 'Live chat rooms' }));

    expect(screen.getByTestId<HTMLInputElement>('ws-api-name').value).toBe('Chat');
    expect(screen.getByTestId<HTMLInputElement>('ws-api-description').value).toBe('Live chat rooms');
    expect(screen.getByTestId<HTMLInputElement>('ws-api-url').value).toBe('wss://chat.test');
  });

  it('names the environment override and the URL requests actually connect to', () => {
    mount(wsApiWire(), {
      environments: [environment({ chat: 'wss://uat.test' })],
      activeEnvironmentId: 'env-1',
    });

    const source = screen.getByTestId('ws-api-url-source').textContent ?? '';
    expect(source).toContain('wss://uat.test');
    expect(source).toContain('this project’s environment');
    // The field still shows the API's own value: that is the thing being edited.
    expect(screen.getByTestId<HTMLInputElement>('ws-api-url').value).toBe('wss://chat.test');
  });

  it('names a workspace environment override too', () => {
    useWorkspaceStore.setState({
      workspace: {
        ...workspaceWire(),
        environments: [environment({ chat: 'wss://ws.test' }, 'ws-env')],
        activeEnvironmentId: 'ws-env',
      },
    });
    mount();

    expect(screen.getByTestId('ws-api-url-source').textContent).toContain('the workspace environment');
  });

  it('sends one update-ws-api patch per committed edit', () => {
    mount();

    const name = screen.getByTestId('ws-api-name');
    fireEvent.change(name, { target: { value: 'Chatroom' } });
    fireEvent.blur(name);
    expect(updateWsApi).toHaveBeenCalledWith('ws-api-1', { name: 'Chatroom' });

    const url = screen.getByTestId('ws-api-url');
    fireEvent.change(url, { target: { value: 'wss://other.test' } });
    fireEvent.keyDown(url, { key: 'Enter' });
    expect(updateWsApi).toHaveBeenLastCalledWith('ws-api-1', { url: 'wss://other.test' });
  });

  it('clears a description back to absent rather than storing an empty string', () => {
    mount(wsApiWire({ description: 'gone soon' }));

    const description = screen.getByTestId('ws-api-description');
    fireEvent.change(description, { target: { value: '' } });
    fireEvent.blur(description);

    expect(updateWsApi).toHaveBeenCalledWith('ws-api-1', { description: null });
  });

  it('refuses to write an empty name', () => {
    mount();

    const name = screen.getByTestId('ws-api-name');
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.blur(name);

    expect(updateWsApi).not.toHaveBeenCalled();
  });

  it('sets the headers every request in the API inherits', () => {
    mount();

    const newName = screen.getByTestId('ws-api-headers-new-name');
    fireEvent.change(newName, { target: { value: 'X-Auth' } });

    expect(updateWsApi).toHaveBeenCalledWith('ws-api-1', {
      headers: [{ enabled: true, name: 'X-Auth', value: '' }],
    });
  });

  it('sets the credentials every request in the API inherits', () => {
    mount();

    fireEvent.change(screen.getByLabelText('API authentication type'), { target: { value: 'basic' } });

    expect(updateWsApi).toHaveBeenCalledWith('ws-api-1', { auth: { type: 'basic' } });
  });

  it('offers no Definition section — a WebSocket API has none', () => {
    mount();
    expect(screen.queryByText('Definition')).toBeNull();
  });

  it('says so, rather than throwing, for an API that no longer exists', () => {
    useProjectStore.setState({ wsApis: {}, projects: {}, projectOf: {} });
    render(
      <TooltipPrimitive.Provider>
        <WsApiTab apiId="gone" />
      </TooltipPrimitive.Provider>,
    );

    expect(screen.getByText('This API is no longer in the project.')).toBeTruthy();
  });
});
