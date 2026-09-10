import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestToolbar } from '../../src/renderer/features/request-editor/toolbar.js';
import { EndpointSelect } from '../../src/renderer/features/request-editor/endpoint-select.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft, makeInterface } from '../mocks/exchange-fixtures.js';

const noop = (): void => undefined;

describe('RequestToolbar', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the operation, SOAP version, and SOAPAction', () => {
    render(
      <RequestToolbar
        draft={makeDraft()}
        summary={makeInterface()}
        endpoint="https://example.test/calc.asmx"
        sending={false}
        onSend={noop}
        onCancel={noop}
        onEndpointChange={noop}
      />,
    );

    expect(screen.getByText('Add')).toBeDefined();
    expect(screen.getByText('SOAP 1.1')).toBeDefined();
    expect(screen.getByText('SOAPAction: http://tempuri.org/Add')).toBeDefined();
  });

  it('sends on click', async () => {
    const onSend = vi.fn();
    render(
      <RequestToolbar
        draft={makeDraft()}
        summary={makeInterface()}
        endpoint="https://example.test/calc.asmx"
        sending={false}
        onSend={onSend}
        onCancel={noop}
        onEndpointChange={noop}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('disables Send when the request resolves to no endpoint', () => {
    render(
      <RequestToolbar
        draft={makeDraft({ endpointId: undefined })}
        summary={makeInterface()}
        endpoint={undefined}
        sending={false}
        onSend={noop}
        onCancel={noop}
        onEndpointChange={noop}
      />,
    );

    expect(screen.getByRole('button', { name: /send/i }).hasAttribute('disabled')).toBe(true);
  });

  it('replaces Send with Cancel while sending', async () => {
    const onCancel = vi.fn();
    render(
      <RequestToolbar
        draft={makeDraft()}
        summary={makeInterface()}
        endpoint="https://example.test/calc.asmx"
        sending
        onSend={noop}
        onCancel={onCancel}
        onEndpointChange={noop}
      />,
    );

    expect(screen.queryByRole('button', { name: /^send$/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('EndpointSelect', () => {
  afterEach(() => {
    cleanup();
  });

  it("lists the operation's binding port first, then the rest, then Custom", () => {
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap12"
        value="https://example.test/calc12.asmx"
        onChange={noop}
      />,
    );

    const options = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(options).toEqual(['https://example.test/calc12.asmx', 'https://example.test/calc.asmx', '__custom__']);
  });

  it('reports the address chosen from the list', async () => {
    const onChange = vi.fn();
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap"
        value="https://example.test/calc.asmx"
        onChange={onChange}
      />,
    );

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Endpoint' }),
      'https://example.test/calc12.asmx',
    );
    expect(onChange).toHaveBeenCalledWith('https://example.test/calc12.asmx');
  });

  it('offers a free-text field once Custom… is chosen', async () => {
    const onChange = vi.fn();
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap"
        value="https://example.test/calc.asmx"
        onChange={onChange}
      />,
    );

    expect(screen.queryByLabelText('Custom endpoint URL')).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Endpoint' }), '__custom__');
    await userEvent.type(screen.getByLabelText('Custom endpoint URL'), '!');
    expect(onChange).toHaveBeenCalledWith('https://example.test/calc.asmx!');
  });

  it('starts in custom mode when the draft endpoint is not a declared port', () => {
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap"
        value="https://localhost:8080/mock"
        onChange={noop}
      />,
    );

    expect(screen.getByLabelText<HTMLInputElement>('Custom endpoint URL').value).toBe('https://localhost:8080/mock');
  });
});

describe('RequestToolbar actions', () => {
  beforeEach(() => {
    // Layout toggles persist through `preferences.update`, so the API has to be in place.
    installWirebenchApi();
    useEditorsStore.setState({ editorLayouts: {} });
    useUiStore.getState().setEditorLayout({ orientation: 'side-by-side', mode: 'split' });
    useProjectStore.setState({ requests: { 'req-1': makeDraft() } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderToolbar() {
    render(
      <RequestToolbar
        draft={makeDraft()}
        summary={makeInterface()}
        endpoint="https://example.test/calc.asmx"
        sending={false}
        onSend={noop}
        onCancel={noop}
        onEndpointChange={noop}
      />,
    );
  }

  it('the orientation toggle writes both the per-request override and the persisted default', async () => {
    installWirebenchApi();
    renderToolbar();

    await userEvent.click(screen.getByRole('button', { name: 'Stack panes vertically' }));

    expect(useEditorsStore.getState().editorLayouts['req-1']).toEqual({ orientation: 'stacked', mode: 'split' });
    expect(useUiStore.getState().editorLayout).toEqual({ orientation: 'stacked', mode: 'split' });
    // The button now offers the way back.
    expect(screen.getByRole('button', { name: 'Place panes side by side' })).toBeDefined();
  });

  it('the mode toggle flips split/tabs in both stores', async () => {
    installWirebenchApi();
    renderToolbar();

    await userEvent.click(screen.getByRole('button', { name: 'Show one pane at a time' }));

    expect(useEditorsStore.getState().editorLayouts['req-1']).toEqual({ orientation: 'side-by-side', mode: 'tabs' });
    expect(useUiStore.getState().editorLayout.mode).toBe('tabs');
  });

  it('Recreate calls request.recreate with keepValues and replaces the envelope in the mirror', async () => {
    const recreate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { envelopeXml: '<recreated/>', kept: 2, added: 1, removed: 0 } });
    installWirebenchApi({ request: { recreate } });
    renderToolbar();

    await userEvent.click(screen.getByTestId('request-recreate'));

    expect(recreate).toHaveBeenCalledWith({
      requestId: 'req-1',
      keepValues: true,
      keepHeaders: true,
      empty: false,
    });
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<recreated/>');
  });

  it('the Recreate menu offers discard-values and empty variants', async () => {
    const recreate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { envelopeXml: '<empty/>', kept: 0, added: 0, removed: 0 } });
    installWirebenchApi({ request: { recreate } });
    renderToolbar();

    await userEvent.click(screen.getByTestId('request-recreate-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Create empty' }));

    expect(recreate).toHaveBeenCalledWith({ requestId: 'req-1', keepValues: false, keepHeaders: false, empty: true });
  });

  it('Copy as cURL writes the command main built to the clipboard', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: "curl --request POST 'x'" } });
    installWirebenchApi({ request: { curl } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderToolbar();

    await userEvent.click(screen.getByTestId('request-curl'));

    expect(curl).toHaveBeenCalledWith({ requestId: 'req-1', shell: 'posix' });
    expect(writeText).toHaveBeenCalledWith("curl --request POST 'x'");
  });

  it('Copy as cURL (PowerShell) asks for the powershell shell', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: 'curl.exe --request POST' } });
    installWirebenchApi({ request: { curl } });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    renderToolbar();

    await userEvent.click(screen.getByTestId('request-curl-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy as cURL (PowerShell)' }));

    expect(curl).toHaveBeenCalledWith({ requestId: 'req-1', shell: 'powershell' });
  });
});
