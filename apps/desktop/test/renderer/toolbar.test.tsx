import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestToolbar } from '../../src/renderer/features/request-editor/toolbar.js';
import { EndpointSelect } from '../../src/renderer/features/request-editor/endpoint-select.js';
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
        sending={false}
        onSend={onSend}
        onCancel={noop}
        onEndpointChange={noop}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('disables Send when the draft has no endpoint', () => {
    render(
      <RequestToolbar
        draft={makeDraft({ endpoint: undefined })}
        summary={makeInterface()}
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
