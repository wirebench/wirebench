import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestPane } from '../../src/renderer/features/request-editor/request-pane.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const PANE_PROPS = {
  requestId: 'req-1',
  interfaceId: 'if-1',
  bindingName: '{http://tempuri.org/}CalculatorSoap',
  operationName: 'Add',
};

describe('RequestPane external replacement', () => {
  beforeEach(() => {
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('drops a pending debounced edit when the envelope is replaced from outside', async () => {
    const onEnvelopeChange = vi.fn();
    const { rerender } = render(
      <RequestPane {...PANE_PROPS} envelopeXml="<original/>" onEnvelopeChange={onEnvelopeChange} onSend={vi.fn()} />,
    );

    const editor = screen.getByLabelText('Request envelope XML');
    editor.focus();
    await userEvent.type(editor, '!', { skipClick: true });
    expect(onEnvelopeChange).not.toHaveBeenCalled(); // still inside the debounce window

    // Recreate lands: main saved a new envelope, and the prop changes from outside this pane.
    rerender(
      <RequestPane {...PANE_PROPS} envelopeXml="<recreated/>" onEnvelopeChange={onEnvelopeChange} onSend={vi.fn()} />,
    );

    expect(screen.getByLabelText('Request envelope XML')).toHaveProperty('value', '<recreated/>');
    // The dropped timer must never fire the stale text back over the replacement.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onEnvelopeChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Request envelope XML')).toHaveProperty('value', '<recreated/>');
  });

  it("keeps a keystroke made while the pane's own earlier edit was still round-tripping", async () => {
    const onEnvelopeChange = vi.fn();
    const { rerender } = render(
      <RequestPane {...PANE_PROPS} envelopeXml="<a/>" onEnvelopeChange={onEnvelopeChange} onSend={vi.fn()} />,
    );

    const editor = screen.getByLabelText<HTMLTextAreaElement>('Request envelope XML');
    editor.focus();
    await userEvent.type(editor, 'X', { skipClick: true });
    const committed = editor.value;
    await waitFor(() => {
      expect(onEnvelopeChange).toHaveBeenCalledWith(committed);
    });

    // The typed-again text is pending when the mirror echoes the *previous* commit back.
    await userEvent.type(screen.getByLabelText('Request envelope XML'), 'Y', { skipClick: true });
    const typedAgain = screen.getByLabelText<HTMLTextAreaElement>('Request envelope XML').value;
    rerender(
      <RequestPane {...PANE_PROPS} envelopeXml={committed} onEnvelopeChange={onEnvelopeChange} onSend={vi.fn()} />,
    );

    await waitFor(() => {
      expect(onEnvelopeChange).toHaveBeenCalledWith(typedAgain);
    });
    expect(screen.getByLabelText('Request envelope XML')).toHaveProperty('value', typedAgain);
  });
});

describe('RequestPane save shortcut', () => {
  beforeEach(() => {
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // The editor area renders one RequestEditor for whichever tab is in front, so switching tabs
  // re-renders this pane with a new `requestId` rather than mounting a new Monaco editor. The
  // ⌘S command is bound once, on mount — it must still save the tab now in front.
  it('saves the request now in front after switching tabs, not the one the editor mounted with', async () => {
    const saveRequest = vi.fn<(requestId: string) => Promise<void>>(() => Promise.resolve());
    useProjectStore.setState({ saveRequest });
    const { rerender } = render(
      <RequestPane {...PANE_PROPS} envelopeXml="<first/>" onEnvelopeChange={vi.fn()} onSend={vi.fn()} />,
    );

    rerender(
      <RequestPane
        {...PANE_PROPS}
        requestId="req-2"
        envelopeXml="<second/>"
        onEnvelopeChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    const editor = screen.getByLabelText('Request envelope XML');
    editor.focus();
    await userEvent.keyboard('{Meta>}s{/Meta}');

    expect(saveRequest).toHaveBeenCalledTimes(1);
    expect(saveRequest).toHaveBeenCalledWith('req-2');
  });
});
