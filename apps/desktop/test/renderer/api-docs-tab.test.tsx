import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { ApiDocsTab, EXAMPLE_PREVIEW_LINES, docsTree } from '../../src/renderer/features/rest-api/api-docs-tab.js';
import { apiDocsTabId, openApiDocsTab } from '../../src/renderer/features/rest-api/api-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { restApiWire, restFolderWire, restRequestWire } from '../helpers/wire-defaults.js';

const LONG_BODY = Array.from({ length: EXAMPLE_PREVIEW_LINES + 5 }, (_, index) => `line ${String(index + 1)}`).join(
  '\n',
);

const FOLDERS = {
  cards: restFolderWire({ id: 'cards', name: 'Cards', order: 1, description: 'All about **cards**.' }),
  limits: restFolderWire({ id: 'limits', name: 'Limits', parentId: 'cards', order: 0 }),
  other: restFolderWire({ id: 'other', apiId: 'api-2', name: 'Elsewhere' }),
};

const REQUESTS = {
  signIn: restRequestWire({ id: 'signIn', name: 'Sign in', method: 'POST', url: '/auth/token', order: 0 }),
  issue: restRequestWire({
    id: 'issue',
    name: 'Issue a card',
    method: 'POST',
    url: '${base_url}/cards',
    folderId: 'cards',
    order: 1,
    headers: [{ name: 'Authorization', value: 'Bearer ${secret:token}', enabled: true }],
    examples: [
      {
        id: 'e1',
        name: 'Created',
        status: 201,
        statusText: 'Created',
        headers: [],
        contentType: 'application/json',
        body: LONG_BODY,
      },
    ],
  }),
  list: restRequestWire({ id: 'list', name: 'List cards', url: '/cards', folderId: 'cards', order: 0 }),
  foreign: restRequestWire({ id: 'foreign', apiId: 'api-2', name: 'Not ours' }),
};

function seed(): void {
  useProjectStore.setState({
    apis: { 'api-1': restApiWire({ name: 'CaaS', description: 'The whole **life** of a program.' }) },
    folders: FOLDERS,
    restRequests: REQUESTS,
  } as never);
}

beforeEach(() => {
  seed();
  useEditorsStore.setState({ tabs: [], activeId: undefined } as never);
});

afterEach(() => {
  cleanup();
});

describe('docsTree', () => {
  it('nests this API’s folders and requests and leaves other APIs out', () => {
    const tree = docsTree('api-1', FOLDERS, REQUESTS);
    expect(tree.requests.map((request) => request.name)).toEqual(['Sign in']);
    expect(tree.folders.map((folder) => folder.name)).toEqual(['Cards']);
    expect(tree.folders[0]?.folders.map((folder) => folder.name)).toEqual(['Limits']);
    expect(tree.folders[0]?.requests.map((request) => request.name).sort()).toEqual(['Issue a card', 'List cards']);
  });
});

describe('ApiDocsTab', () => {
  it('shows the API, a contents list and every entry in the explorer’s order', () => {
    render(<ApiDocsTab apiId="api-1" />);

    expect(screen.getByRole('heading', { level: 2, name: 'CaaS' })).toBeTruthy();
    expect(screen.getAllByTestId('api-docs-toc').map((item) => item.textContent)).toEqual([
      'Cards',
      'Limits',
      'GETList cards',
      'POSTIssue a card',
      'POSTSign in',
    ]);
    expect(screen.getAllByTestId('api-docs-folder')[0]?.querySelector('strong')?.textContent).toBe('cards');
    expect(screen.getAllByTestId('api-docs-request')).toHaveLength(3);
    // Every contents entry has the section it jumps to.
    expect(document.getElementById('api-docs-issue-a-card')).not.toBeNull();
    fireEvent.click(screen.getAllByTestId('api-docs-toc')[3] as HTMLElement);
  });

  it('shows values as written, never resolved', () => {
    render(<ApiDocsTab apiId="api-1" />);
    const issue = screen.getAllByTestId('api-docs-request').find((section) => section.textContent.includes('Issue'));
    expect(issue?.textContent).toContain('${base_url}/cards');
    expect(issue?.textContent).toContain('Bearer ${secret:token}');
  });

  it('shows the first lines of a long example, then all of it on request', () => {
    render(<ApiDocsTab apiId="api-1" />);
    const example = screen.getByTestId('api-docs-example');
    expect(example.textContent).toContain(`line ${String(EXAMPLE_PREVIEW_LINES)}`);
    expect(example.textContent).not.toContain(`line ${String(EXAMPLE_PREVIEW_LINES + 1)}`);

    fireEvent.click(screen.getByTestId('api-docs-example-toggle'));
    expect(screen.getByTestId('api-docs-example').textContent).toContain(`line ${String(EXAMPLE_PREVIEW_LINES + 5)}`);
  });

  it('says so for an API that is gone', () => {
    render(<ApiDocsTab apiId="gone" />);
    expect(screen.getByText('This API is no longer in the project.')).toBeTruthy();
  });
});

describe('openApiDocsTab', () => {
  it('opens one documentation tab per API', () => {
    openApiDocsTab('api-1');
    openApiDocsTab('api-1');
    const tabs = useEditorsStore.getState().tabs.filter((tab) => tab.kind === 'api-docs');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ id: apiDocsTabId('api-1'), title: 'CaaS — Docs', apiDocsId: 'api-1' });
  });

  it('ignores an API the mirror does not hold', () => {
    openApiDocsTab('gone');
    expect(useEditorsStore.getState().tabs).toHaveLength(0);
  });
});

describe('ApiDocsTab export', () => {
  it('asks main to export in the chosen format', async () => {
    const exportDocs = vi.fn().mockResolvedValue({ ok: true, value: { cancelled: false, path: '/tmp/CaaS.md' } });
    installWirebenchApi({ api: { exportDocs } });
    render(<ApiDocsTab apiId="api-1" />);

    fireEvent.click(screen.getByTestId('api-docs-export-markdown'));
    await waitFor(() => expect(exportDocs).toHaveBeenCalledWith({ apiId: 'api-1', format: 'markdown' }));
    fireEvent.click(await screen.findByTestId('api-docs-export-html'));
    await waitFor(() => expect(exportDocs).toHaveBeenLastCalledWith({ apiId: 'api-1', format: 'html' }));
  });
});
