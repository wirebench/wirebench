/**
 * The API tab's Definition card.
 *
 * The properties worth pinning: nothing is read until the user asks to see it, a definition that
 * was not cached offers nothing rather than a button that would go to the network, and the text of
 * one document is fetched on its own so a multi-file definition never crosses the bridge at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ApiDefinitionCard,
  definitionDocumentLabel,
  definitionLanguage,
} from '../../src/renderer/features/rest-api/api-definition-card.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const DEFINITION = { source: 'https://api.test/openapi.yaml', cache: true, version: '3.0.3' } as const;

const documents = vi.fn();
const documentText = vi.fn();
const exportDefinition = vi.fn();

beforeEach(() => {
  documents.mockReset().mockResolvedValue({
    ok: true,
    value: {
      documents: [
        { location: 'https://api.test/openapi.yaml', size: 1200 },
        { location: 'https://api.test/shared/schemas.yaml', size: 340 },
      ],
      rootLocation: 'https://api.test/openapi.yaml',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      declaredVersion: '3.0.3',
    },
  });
  documentText.mockReset().mockResolvedValue({ ok: true, value: { text: 'openapi: 3.0.3\n' } });
  exportDefinition.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true, files: [] } });
  installWirebenchApi({
    api: { definitionDocuments: documents, definitionText: documentText, exportDefinition },
  });
});

afterEach(() => {
  cleanup();
});

describe('definitionDocumentLabel', () => {
  it('names a document by its last path segment, query and fragment aside', () => {
    expect(definitionDocumentLabel('https://api.test/v1/openapi.yaml?x=1')).toBe('openapi.yaml');
    expect(definitionDocumentLabel('inline:openapi')).toBe('inline:openapi');
  });
});

describe('definitionLanguage', () => {
  it('colours JSON as JSON and everything else as plain text', () => {
    expect(definitionLanguage('https://api.test/openapi.json')).toBe('json');
    // No YAML grammar is bundled, and a wrong one would mis-colour every line rather than none.
    expect(definitionLanguage('https://api.test/openapi.yaml')).toBe('text');
    expect(definitionLanguage('https://api.test/spec')).toBe('text');
  });
});

describe('the definition card', () => {
  it('reads nothing until the user asks to see a document', () => {
    render(<ApiDefinitionCard apiId="api-1" definition={DEFINITION} />);

    expect(screen.getByTestId('api-definition-source').textContent).toBe(DEFINITION.source);
    expect(documents).not.toHaveBeenCalled();
    expect(documentText).not.toHaveBeenCalled();
  });

  it('lists the documents and fetches only the one on screen', async () => {
    render(<ApiDefinitionCard apiId="api-1" definition={DEFINITION} />);

    await userEvent.click(screen.getByTestId('api-definition-view'));

    await waitFor(() => {
      expect(screen.getByTestId('api-definition-document')).toBeTruthy();
    });
    expect(documents).toHaveBeenCalledWith({ apiId: 'api-1' });
    // The root, and only the root: the second document is listed, not loaded.
    expect(documentText).toHaveBeenCalledTimes(1);
    expect(documentText).toHaveBeenCalledWith({ apiId: 'api-1', location: 'https://api.test/openapi.yaml' });
    const options = screen.getByTestId<HTMLSelectElement>('api-definition-document').options;
    expect([...options].map((option) => option.textContent)).toEqual(['openapi.yaml — 1.2 KB', 'schemas.yaml — 340 B']);
  });

  it('fetches another document when one is selected', async () => {
    render(<ApiDefinitionCard apiId="api-1" definition={DEFINITION} />);
    await userEvent.click(screen.getByTestId('api-definition-view'));
    await waitFor(() => {
      expect(screen.getByTestId('api-definition-document')).toBeTruthy();
    });

    await userEvent.selectOptions(
      screen.getByTestId('api-definition-document'),
      'https://api.test/shared/schemas.yaml',
    );

    await waitFor(() => {
      expect(documentText).toHaveBeenCalledWith({ apiId: 'api-1', location: 'https://api.test/shared/schemas.yaml' });
    });
  });

  it('hides the viewer again without re-reading the list', async () => {
    render(<ApiDefinitionCard apiId="api-1" definition={DEFINITION} />);
    await userEvent.click(screen.getByTestId('api-definition-view'));
    await waitFor(() => {
      expect(screen.getByTestId('api-definition-document')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('api-definition-view'));
    expect(screen.queryByTestId('api-definition-document')).toBeNull();

    await userEvent.click(screen.getByTestId('api-definition-view'));
    await waitFor(() => {
      expect(screen.getByTestId('api-definition-document')).toBeTruthy();
    });
    expect(documents).toHaveBeenCalledTimes(1);
  });

  it('says what went wrong rather than showing an empty viewer', async () => {
    documents.mockResolvedValue({ ok: false, error: { code: 'definition-cache-missing', message: 'No cache here' } });
    render(<ApiDefinitionCard apiId="api-1" definition={DEFINITION} />);

    await userEvent.click(screen.getByTestId('api-definition-view'));

    await waitFor(() => {
      expect(screen.getByTestId('api-definition-error').textContent).toBe('No cache here');
    });
    expect(screen.queryByTestId('api-definition-document')).toBeNull();
  });

  it('offers nothing to view or export for a definition that was not cached', () => {
    render(<ApiDefinitionCard apiId="api-1" definition={{ ...DEFINITION, cache: false }} />);

    expect(screen.queryByTestId('api-definition-view')).toBeNull();
    expect(screen.queryByTestId('api-definition-export')).toBeNull();
    expect(screen.getByText(/not cached/)).toBeTruthy();
  });

  it('exports through main’s own dialog, and says nothing when it is dismissed', async () => {
    render(<ApiDefinitionCard apiId="api-1" definition={DEFINITION} />);

    await userEvent.click(screen.getByTestId('api-definition-export'));

    expect(exportDefinition).toHaveBeenCalledWith({ apiId: 'api-1' });
    expect(screen.queryByText(/Exported/)).toBeNull();
  });

  it('reports how many documents an export wrote', async () => {
    exportDefinition.mockResolvedValue({
      ok: true,
      value: { cancelled: false, dir: '/out', files: ['openapi.yaml', 'schemas.yaml'] },
    });
    render(<ApiDefinitionCard apiId="api-1" definition={DEFINITION} />);

    await userEvent.click(screen.getByTestId('api-definition-export'));

    await waitFor(() => {
      expect(exportDefinition).toHaveBeenCalled();
    });
  });
});
