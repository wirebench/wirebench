/**
 * The API tab.
 *
 * The base URL row is what these tests are mostly about: an environment override is what requests
 * actually use, so the row has to say so rather than leaving a user editing a field their sends
 * ignore. The rest pins that each edit sends one `update-api` patch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ApiTab, effectiveBaseUrl } from '../../src/renderer/features/rest-api/api-tab.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import { NO_REST, PROJECT_SETTINGS, restApiWire } from '../helpers/wire-defaults.js';
import type { EnvironmentWire, ProjectWire, RestApiWire } from '../../src/shared/wire-types.js';

const updateApi = vi.fn();

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

/** Mirrors one API, then mounts its tab. */
function mount(api: RestApiWire = restApiWire(), projectOverrides: Partial<ProjectWire> = {}): void {
  const wire = project({ apis: [api], ...projectOverrides });
  useProjectStore.setState({
    projects: { p1: wire },
    apis: { [api.id]: api },
    projectOf: { [api.id]: 'p1', p1: 'p1' },
    updateApi,
  });
  render(
    <TooltipPrimitive.Provider>
      <ApiTab apiId={api.id} />
    </TooltipPrimitive.Provider>,
  );
}

beforeEach(() => {
  updateApi.mockReset().mockResolvedValue(undefined);
  installWirebenchApi();
  useWorkspaceStore.setState({ workspace: null });
});

afterEach(() => {
  cleanup();
});

describe('effectiveBaseUrl', () => {
  it("takes the API's own value when no environment overrides it", () => {
    expect(effectiveBaseUrl({ api: { slug: 'petstore', baseUrl: 'https://api.test' } })).toEqual({
      url: 'https://api.test',
      source: 'api',
    });
  });

  it("lets the project's own environment win over the workspace's", () => {
    expect(
      effectiveBaseUrl({
        api: { slug: 'petstore', baseUrl: 'https://api.test' },
        projectOverride: 'https://project.test',
        workspaceOverride: 'https://workspace.test',
      }),
    ).toEqual({ url: 'https://project.test', source: 'environment' });
  });

  it('falls through an empty override rather than pointing a request at nothing', () => {
    expect(
      effectiveBaseUrl({ api: { slug: 'petstore', baseUrl: 'https://api.test' }, projectOverride: '' }),
    ).toMatchObject({ source: 'api' });
  });
});

describe('ApiTab', () => {
  it('shows the name, description and base URL, and says the API itself is what requests use', () => {
    mount(restApiWire({ description: 'Pets, and their people' }));

    expect(screen.getByTestId<HTMLInputElement>('api-name').value).toBe('Petstore');
    expect(screen.getByTestId<HTMLInputElement>('api-description').value).toBe('Pets, and their people');
    expect(screen.getByTestId<HTMLInputElement>('api-base-url').value).toBe('https://api.test');
    expect(screen.getByTestId('api-base-url-source').textContent).toBe('Requests use this value.');
  });

  it('names the environment override and the URL requests actually go to', () => {
    mount(restApiWire(), {
      environments: [environment({ petstore: 'https://uat.test' })],
      activeEnvironmentId: 'env-1',
    });

    const source = screen.getByTestId('api-base-url-source').textContent ?? '';
    expect(source).toContain('https://uat.test');
    expect(source).toContain('this project’s environment');
    // The field still shows the API's own value: that is the thing being edited.
    expect(screen.getByTestId<HTMLInputElement>('api-base-url').value).toBe('https://api.test');
  });

  it('names a workspace environment override too', () => {
    useWorkspaceStore.setState({
      workspace: {
        ...workspaceWire(),
        environments: [environment({ petstore: 'https://ws.test' }, 'ws-env')],
        activeEnvironmentId: 'ws-env',
      },
    });
    mount();

    expect(screen.getByTestId('api-base-url-source').textContent).toContain('the workspace environment');
  });

  it('sends one update-api patch per committed edit', () => {
    mount();

    const name = screen.getByTestId('api-name');
    fireEvent.change(name, { target: { value: 'Pets' } });
    fireEvent.blur(name);
    expect(updateApi).toHaveBeenCalledWith('api-1', { name: 'Pets' });

    const baseUrl = screen.getByTestId('api-base-url');
    fireEvent.change(baseUrl, { target: { value: 'https://other.test' } });
    fireEvent.keyDown(baseUrl, { key: 'Enter' });
    expect(updateApi).toHaveBeenLastCalledWith('api-1', { baseUrl: 'https://other.test' });
  });

  it('clears a description back to absent rather than storing an empty string', () => {
    mount(restApiWire({ description: 'gone soon' }));

    const description = screen.getByTestId('api-description');
    fireEvent.change(description, { target: { value: '' } });
    fireEvent.blur(description);

    expect(updateApi).toHaveBeenCalledWith('api-1', { description: null });
  });

  it('refuses to write an empty name', () => {
    mount();

    const name = screen.getByTestId('api-name');
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.blur(name);

    expect(updateApi).not.toHaveBeenCalled();
  });

  it('offers the servers an import recorded as suggestions, not as the only choices', () => {
    mount(
      restApiWire({ servers: [{ url: 'https://api.test' }, { url: 'https://sandbox.test', description: 'Sandbox' }] }),
    );

    const field = screen.getByTestId('api-base-url');
    expect(field.getAttribute('list')).toBe('api-servers');
    // A plain input, so any URL can be typed.
    expect(field.tagName).toBe('INPUT');
  });

  it('sets the credentials every request in the API inherits', () => {
    mount();

    fireEvent.change(screen.getByLabelText('API authentication type'), { target: { value: 'basic' } });

    expect(updateApi).toHaveBeenCalledWith('api-1', { auth: { type: 'basic' } });
  });

  it('shows the definition card only for an imported API', () => {
    mount();
    expect(screen.queryByTestId('api-definition-card')).toBeNull();
    cleanup();

    mount(restApiWire({ definition: { source: 'https://api.test/openapi.yaml', cache: true, version: '3.0.3' } }));
    expect(screen.getByTestId('api-definition-source').textContent).toBe('https://api.test/openapi.yaml');
  });

  it('says so, rather than throwing, for an API that no longer exists', () => {
    useProjectStore.setState({ apis: {}, projects: {}, projectOf: {} });
    render(
      <TooltipPrimitive.Provider>
        <ApiTab apiId="gone" />
      </TooltipPrimitive.Provider>,
    );

    expect(screen.getByText('This API is no longer in the project.')).toBeTruthy();
  });
});
