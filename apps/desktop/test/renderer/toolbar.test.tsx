import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestToolbar } from '../../src/renderer/features/request-editor/toolbar.js';
import { EndpointSelect } from '../../src/renderer/features/request-editor/endpoint-select.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft, makeInterface } from '../mocks/exchange-fixtures.js';

const noop = (): void => undefined;

describe('RequestToolbar', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the operation and SOAP version, with the SOAPAction in the badge title', () => {
    render(
      <RequestToolbar
        draft={makeDraft()}
        summary={makeInterface()}
        endpoint="https://example.test/calc.asmx"
        sending={false}
        onSend={noop}
        onCancel={noop}
        onEndpointChange={noop}
        onValidate={noop}
      />,
    );

    const badge = screen.getByTestId('request-operation');
    expect(badge.textContent).toContain('Add');
    expect(badge.textContent).toContain('SOAP 1.1');
    expect(badge.getAttribute('title')).toContain('http://tempuri.org/Add');
  });

  it('shows the whole endpoint URL in an always-visible field', () => {
    const long = `https://services.example.test/very/long/path/that/keeps/going/Calculator.asmx?wsdl=1`;
    render(
      <RequestToolbar
        draft={makeDraft()}
        summary={makeInterface()}
        endpoint={long}
        sending={false}
        onSend={noop}
        onCancel={noop}
        onEndpointChange={noop}
        onValidate={noop}
      />,
    );

    expect(screen.getByTestId<HTMLInputElement>('request-endpoint').value).toBe(long);
  });

  it('keeps the environment override read-only, but still labelled as the endpoint', () => {
    render(
      <RequestToolbar
        draft={makeDraft()}
        summary={makeInterface()}
        endpoint="https://uat.example.test/calc.asmx"
        endpointSource="environment"
        sending={false}
        onSend={noop}
        onCancel={noop}
        onEndpointChange={noop}
        onValidate={noop}
      />,
    );

    const field = screen.getByTestId<HTMLInputElement>('request-endpoint');
    expect(field.value).toBe('https://uat.example.test/calc.asmx');
    expect(field.readOnly).toBe(true);
    expect(screen.getByTestId('endpoint-env-badge')).toBeDefined();
  });

  it('no longer carries Recreate, cURL or Clone controls', () => {
    render(
      <RequestToolbar
        draft={makeDraft()}
        summary={makeInterface()}
        endpoint="https://example.test/calc.asmx"
        sending={false}
        onSend={noop}
        onCancel={noop}
        onEndpointChange={noop}
        onValidate={noop}
      />,
    );

    expect(screen.queryByTestId('request-recreate')).toBeNull();
    expect(screen.queryByTestId('request-curl')).toBeNull();
    expect(screen.queryByTestId('request-clone')).toBeNull();
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
        onValidate={noop}
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
        onValidate={noop}
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
        onValidate={noop}
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

  it('shows the current URL in full and commits what is typed into it', async () => {
    const onChange = vi.fn();
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap"
        value="https://example.test/calc.asmx"
        onChange={onChange}
      />,
    );

    const field = screen.getByLabelText<HTMLInputElement>('Endpoint');
    expect(field.value).toBe('https://example.test/calc.asmx');

    await userEvent.type(field, '!');
    expect(onChange).toHaveBeenCalledWith('https://example.test/calc.asmx!');
  });

  it('shows an endpoint that is not a declared port just as plainly', () => {
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap"
        value="https://localhost:8080/mock"
        onChange={noop}
      />,
    );

    expect(screen.getByLabelText<HTMLInputElement>('Endpoint').value).toBe('https://localhost:8080/mock');
  });

  it("lists every declared address in its menu, the operation's own binding first", async () => {
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap12"
        value="https://example.test/calc12.asmx"
        onChange={noop}
      />,
    );

    await userEvent.click(screen.getByTestId('request-endpoint-menu'));

    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent ?? '');
    expect(items[0]).toContain('https://example.test/calc12.asmx');
    expect(items[1]).toContain('https://example.test/calc.asmx');
    expect(items[1]).toContain('Calculator · CalculatorSoap');
  });

  it('reports the address chosen from the menu', async () => {
    const onChange = vi.fn();
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap"
        value="https://example.test/calc.asmx"
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByTestId('request-endpoint-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: /calc12\.asmx/ }));

    expect(onChange).toHaveBeenCalledWith('https://example.test/calc12.asmx');
  });

  it('offers the endpoint manager only when there is one to open', async () => {
    const onEditEndpoints = vi.fn();
    render(
      <EndpointSelect
        summary={makeInterface()}
        bindingName="{http://tempuri.org/}CalculatorSoap"
        value="https://example.test/calc.asmx"
        onChange={noop}
        onEditEndpoints={onEditEndpoints}
      />,
    );

    await userEvent.click(screen.getByTestId('request-endpoint-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit endpoints…' }));

    expect(onEditEndpoints).toHaveBeenCalledOnce();
  });
});

describe('RequestToolbar actions', () => {
  beforeEach(() => {
    // Layout toggles persist through `preferences.update`, so the API has to be in place.
    installWirebenchApi();
    useEditorsStore.setState({ editorLayouts: {} });
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
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
        onValidate={noop}
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

  it('Show code opens the Code slide-over', async () => {
    renderToolbar();

    await userEvent.click(screen.getByTestId('request-code'));

    expect(useUiStore.getState().slideOver).toMatchObject({ open: true });
  });
});
