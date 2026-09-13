import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { placeholderFor, QueryView } from '../../src/renderer/features/request-editor/views/query-view.js';
import type { QuerySource } from '../../src/renderer/features/request-editor/views/query-view.js';

const XML = '<a xmlns:tem="http://tempuri.org/"><tem:AddResult>3</tem:AddResult></a>';

const DEFAULT_NAMESPACES_RESULT = { ok: true, value: { namespaces: { tem: 'http://tempuri.org/' }, suggestions: {} } };
const DEFAULT_EVALUATE_RESULT = {
  ok: true,
  value: { kind: 'nodes', items: [{ text: '3', nodeKind: 'text', path: '/a[1]/tem:AddResult[1]' }], truncated: false },
};

/** Builds a fresh `QuerySource` plus direct handles to its two mocks (avoids the
 * `unbound-method` lint rule that fires when a mocked method is read back off the object). */
function stubSource(overrides?: { readonly namespaces?: unknown; readonly evaluate?: unknown }) {
  const namespaces = vi.fn().mockResolvedValue(overrides?.namespaces ?? DEFAULT_NAMESPACES_RESULT);
  const evaluate = vi.fn().mockResolvedValue(overrides?.evaluate ?? DEFAULT_EVALUATE_RESULT);
  const source: QuerySource = { namespaces, evaluate };
  return { source, namespaces, evaluate };
}

describe('QueryView', () => {
  afterEach(() => {
    cleanup();
  });

  it('seeds the namespace table from xpath.namespaces', async () => {
    const { source, namespaces } = stubSource();
    render(<QueryView requestId="r1" xml={XML} source={source} />);

    await waitFor(() => expect(namespaces).toHaveBeenCalledWith({ xml: XML }));
    await waitFor(() => expect(screen.getByDisplayValue('tem')).toBeDefined());
    expect(screen.getByDisplayValue('http://tempuri.org/')).toBeDefined();
  });

  it('seeds the default-namespace row with the suggested prefix and sends it on Run', async () => {
    const { source, namespaces, evaluate } = stubSource({
      namespaces: {
        ok: true,
        value: { namespaces: { '': 'http://tempuri.org/' }, suggestions: { 'http://tempuri.org/': 'tem' } },
      },
    });
    render(<QueryView requestId="r5" xml={XML} source={source} />);

    await waitFor(() => expect(namespaces).toHaveBeenCalled());
    // The default namespace stays visible (its URI row is not dropped) and is pre-filled with
    // the suggested prefix, editable rather than left blank.
    expect(screen.getByDisplayValue('tem')).toBeDefined();
    expect(screen.getByDisplayValue('http://tempuri.org/')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();

    const textarea = screen.getByLabelText('Query expression');
    await userEvent.type(textarea, 'count(//tem:AddResult)');
    await userEvent.click(screen.getByTestId('query-run'));

    await waitFor(() =>
      expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ namespaces: { tem: 'http://tempuri.org/' } })),
    );
  });

  it('shows a validation hint instead of silently dropping an empty-prefix row', async () => {
    const { source, namespaces } = stubSource({
      namespaces: {
        ok: true,
        // No suggestion available for this URI, so the row is seeded with an empty prefix.
        value: { namespaces: { '': 'http://tempuri.org/' }, suggestions: {} },
      },
    });
    render(<QueryView requestId="r6" xml={XML} source={source} />);
    await waitFor(() => expect(namespaces).toHaveBeenCalled());

    expect(screen.getByDisplayValue('http://tempuri.org/')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain("can't be referenced");
  });

  it('runs the query on Enter and renders node results', async () => {
    const { source, namespaces, evaluate } = stubSource();
    render(<QueryView requestId="r1" xml={XML} source={source} />);
    await waitFor(() => expect(namespaces).toHaveBeenCalled());

    const textarea = screen.getByLabelText('Query expression');
    await userEvent.type(textarea, '//tem:AddResult/text()');
    await userEvent.type(textarea, '{Enter}');

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ xml: XML, expression: '//tem:AddResult/text()', language: 'xpath' }),
    );
    expect(await screen.findByText('3')).toBeDefined();
  });

  it('Shift+Enter inserts a newline instead of running', async () => {
    const { source, namespaces, evaluate } = stubSource();
    render(<QueryView requestId="r1" xml={XML} source={source} />);
    await waitFor(() => expect(namespaces).toHaveBeenCalled());

    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Query expression');
    await userEvent.type(textarea, 'a{Shift>}{Enter}{/Shift}b');

    expect(evaluate).not.toHaveBeenCalled();
    expect(textarea.value).toBe('a\nb');
  });

  it('calls onReveal with the item range when Reveal is clicked', async () => {
    const { source, namespaces, evaluate } = stubSource();
    const onReveal = vi.fn();
    render(<QueryView requestId="r1" xml={XML} source={source} onReveal={onReveal} />);
    await waitFor(() => expect(namespaces).toHaveBeenCalled());

    const runButton = screen.getByTestId('query-run');
    const textarea = screen.getByLabelText('Query expression');
    await userEvent.type(textarea, '//tem:AddResult');
    // This test's stub result has no range, so patch it to include one.
    evaluate.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: 'nodes',
        items: [
          {
            text: '<tem:AddResult>3</tem:AddResult>',
            nodeKind: 'element',
            path: '/a[1]',
            range: { start: 10, end: 20 },
          },
        ],
        truncated: false,
        httpVersion: '1.1',
      },
    });
    await userEvent.click(runButton);

    const reveal = await screen.findByRole('button', { name: 'Reveal' });
    await userEvent.click(reveal);
    expect(onReveal).toHaveBeenCalledWith({ start: 10, end: 20 });
  });

  it('renders an error result with its position', async () => {
    const { source, namespaces } = stubSource({
      evaluate: {
        ok: true,
        value: { kind: 'error', message: 'Failed to parse script', code: 'XPST0003', position: { line: 1, column: 3 } },
      },
    });
    render(<QueryView requestId="r1" xml={XML} source={source} />);
    await waitFor(() => expect(namespaces).toHaveBeenCalled());

    const textarea = screen.getByLabelText('Query expression');
    await userEvent.click(textarea);
    await userEvent.paste('//[');
    await userEvent.click(screen.getByTestId('query-run'));

    expect((await screen.findByRole('alert')).textContent).toContain('Failed to parse script');
    expect(screen.getByText('Line 1, column 3')).toBeDefined();
  });

  it('adds a namespace row and includes it when evaluating', async () => {
    const { source, namespaces, evaluate } = stubSource({
      namespaces: { ok: true, value: { namespaces: {}, suggestions: {} } },
    });
    render(<QueryView requestId="r2" xml={XML} source={source} />);
    await waitFor(() => expect(namespaces).toHaveBeenCalled());

    await userEvent.click(screen.getByText('+ Add namespace'));
    await userEvent.type(screen.getByLabelText('Namespace prefix'), 'tem');
    await userEvent.type(screen.getByLabelText('Namespace URI'), 'http://tempuri.org/');

    const textarea = screen.getByLabelText('Query expression');
    await userEvent.type(textarea, 'count(//tem:AddResult)');
    await userEvent.click(screen.getByTestId('query-run'));

    await waitFor(() =>
      expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ namespaces: { tem: 'http://tempuri.org/' } })),
    );
  });

  it('runs an example expression from the empty state', async () => {
    const { source, namespaces, evaluate } = stubSource();
    render(<QueryView requestId="r3" xml={XML} source={source} />);
    await waitFor(() => expect(namespaces).toHaveBeenCalled());

    await userEvent.click(screen.getByText('count(//*)'));

    await waitFor(() => expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ expression: 'count(//*)' })));
  });

  it('keeps expression history across remounts of the same request', async () => {
    const { source, namespaces, evaluate } = stubSource();
    const { unmount } = render(<QueryView requestId="r4" xml={XML} source={source} />);
    await waitFor(() => expect(namespaces).toHaveBeenCalled());
    const textarea = screen.getByLabelText('Query expression');
    await userEvent.type(textarea, 'count(//*)');
    await userEvent.type(textarea, '{Enter}');
    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    unmount();

    act(() => {
      render(<QueryView requestId="r4" xml={XML} source={stubSource().source} />);
    });
    expect(await screen.findByTitle('count(//*)')).toBeDefined();
  });
});

describe('QueryView over a JSON response', () => {
  const JSON_BODY = '{"items":[{"id":1,"status":"open"}]}';

  afterEach(() => {
    cleanup();
  });

  it('asks main to evaluate against JSON, and never asks about namespaces', async () => {
    const { source, namespaces, evaluate } = stubSource({
      evaluate: { ok: true, value: { kind: 'values', items: [{ text: '1', type: 'xs:integer' }], truncated: false } },
    });
    render(<QueryView requestId="r1" xml={JSON_BODY} documentKind="json" source={source} />);

    await userEvent.click(screen.getByLabelText('Query expression'));
    await userEvent.paste('?items?*?id');
    await userEvent.click(screen.getByTestId('query-run'));

    await waitFor(() => {
      expect(evaluate).toHaveBeenCalledWith({
        xml: JSON_BODY,
        expression: '?items?*?id',
        language: 'xpath',
        namespaces: {},
        kind: 'json',
      });
    });
    // JSON binds no namespaces, so there is nothing to seed and nothing to ask.
    expect(namespaces).not.toHaveBeenCalled();
  });

  it('hides the namespace table and says where an expression starts instead', () => {
    const { source } = stubSource();
    render(<QueryView requestId="r1" xml={JSON_BODY} documentKind="json" source={source} />);

    expect(screen.queryByLabelText('Namespace prefix')).toBeNull();
    expect(screen.queryByText('+ Add namespace')).toBeNull();
    expect(screen.getByText(/is the context item/)).toBeDefined();
  });

  it('keeps both languages: XQuery over JSON is a FLWOR over its arrays', async () => {
    const { source, evaluate } = stubSource({
      evaluate: { ok: true, value: { kind: 'values', items: [{ text: '1', type: 'xs:integer' }], truncated: false } },
    });
    render(<QueryView requestId="r1" xml={JSON_BODY} documentKind="json" source={source} />);

    await userEvent.click(screen.getByRole('radio', { name: 'XQuery 3.1' }));
    await userEvent.click(screen.getByLabelText('Query expression'));
    await userEvent.paste('for $i in ?items?* return $i?id');
    await userEvent.click(screen.getByTestId('query-run'));

    await waitFor(() => {
      expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ language: 'xquery', kind: 'json' }));
    });
  });

  it('still sends no kind for an XML document, so the channel default stands', async () => {
    const { source, evaluate } = stubSource();
    render(<QueryView requestId="r1" xml={XML} source={source} />);

    await userEvent.click(screen.getByLabelText('Query expression'));
    await userEvent.paste('//a');
    await userEvent.click(screen.getByTestId('query-run'));

    await waitFor(() => {
      expect(evaluate).toHaveBeenCalled();
    });
    expect(evaluate.mock.calls[0]?.[0]).not.toHaveProperty('kind');
  });
});

describe('placeholderFor', () => {
  it('offers a working expression for the document actually on screen', () => {
    expect(placeholderFor('xpath', 'xml')).toBe('//tem:AddResult/text()');
    expect(placeholderFor('xquery', 'xml')).toContain('for $x in');
    expect(placeholderFor('xpath', 'json')).toBe('?items?*[?status = "open"]?id');
    expect(placeholderFor('xquery', 'json')).toContain('for $i in ?items?*');
  });
});
