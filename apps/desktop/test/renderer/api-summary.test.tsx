import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApiSummary, countApi, sourceName } from '../../src/renderer/features/rest-api/api-summary.js';
import { useSettingsPageTabStore } from '../../src/renderer/components/settings-page-tabs.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { restApiWire } from '../helpers/wire-defaults.js';
import { resetSettingsTabs } from '../helpers/settings-page-tabs.js';
import type { RestApiWire } from '../../src/shared/kinds/rest/wire.js';

const FOLDERS = {
  f1: { id: 'f1', apiId: 'api-1' },
  f2: { id: 'f2', apiId: 'api-1', parentId: 'f1' },
  other: { id: 'other', apiId: 'api-2' },
};
const REQUESTS = {
  r1: { id: 'r1', apiId: 'api-1' },
  r2: { id: 'r2', apiId: 'api-1', folderId: 'f2' },
  r3: { id: 'r3', apiId: 'api-1', folderId: 'f1' },
  r4: { id: 'r4', apiId: 'api-2' },
};

function mount(api: RestApiWire, baseUrl = { url: 'https://api.test', from: 'the API' }): void {
  useProjectStore.setState({ apis: { [api.id]: api }, folders: FOLDERS, restRequests: REQUESTS } as never);
  render(<ApiSummary apiId={api.id} baseUrl={baseUrl} />);
}

beforeEach(() => {
  resetSettingsTabs();
});

afterEach(() => {
  cleanup();
});

describe('countApi', () => {
  it('counts only this API’s requests and folders, at any depth', () => {
    expect(countApi('api-1', FOLDERS, REQUESTS)).toEqual({ requests: 3, folders: 2 });
    expect(countApi('none', FOLDERS, REQUESTS)).toEqual({ requests: 0, folders: 0 });
  });
});

describe('sourceName', () => {
  it('names a URL by its last path part, or its host', () => {
    expect(sourceName('https://api.test/specs/openapi.yaml')).toBe('openapi.yaml');
    expect(sourceName('https://api.test/')).toBe('api.test');
  });

  it('names a file by its base name', () => {
    expect(sourceName('/Users/me/Downloads/caas.postman_collection.json')).toBe('caas.postman_collection.json');
    expect(sourceName('C:\\specs\\pets.json')).toBe('pets.json');
  });
});

describe('ApiSummary', () => {
  it('shows counts, the auth type and where requests go', () => {
    mount(restApiWire({ auth: { type: 'bearer', token: 'secret:t' } as never }), {
      url: 'https://uat.test',
      from: 'this project’s environment',
    });

    expect(screen.getByTestId('api-summary-requests').textContent).toBe('3 requests');
    expect(screen.getByTestId('api-summary-folders').textContent).toBe('2 folders');
    expect(screen.getByTestId('api-summary-auth').textContent).toBe('Bearer token');
    expect(screen.getByTestId('api-summary-base-url').textContent).toBe('https://uat.test');
    expect(screen.getByText('From this project’s environment')).toBeTruthy();
  });

  it('says None for an API with no auth of its own', () => {
    mount(restApiWire());
    expect(screen.getByTestId('api-summary-auth').textContent).toBe('None');
  });

  it('jumps to the Authentication and Definition tabs', () => {
    mount(restApiWire({ definition: { source: 'https://api.test/openapi.yaml', cache: true, version: '3.0.3' } }));

    fireEvent.click(screen.getByTestId('api-summary-auth'));
    expect(useSettingsPageTabStore.getState().selected['api-1']).toBe('auth');
    expect(screen.getByTestId('api-summary-definition').textContent).toBe('openapi.yaml');
    fireEvent.click(screen.getByTestId('api-summary-definition'));
    expect(useSettingsPageTabStore.getState().selected['api-1']).toBe('definition');
  });

  it('has no Definition line for an API made by hand', () => {
    mount(restApiWire());
    expect(screen.queryByTestId('api-summary-definition')).toBeNull();
  });
});
