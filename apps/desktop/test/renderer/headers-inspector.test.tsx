import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  computedSoapHeaders,
  HeadersInspector,
} from '../../src/renderer/features/request-editor/inspectors/headers-inspector.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import type { HeaderEntryWire } from '../../src/shared/wire-types.js';

const editRequest = vi.fn();

/** `makeDraft` leaves out the properties the computed headers read; these are the defaults. */
function draft(overrides: Parameters<typeof makeDraft>[0]): ReturnType<typeof makeDraft> {
  const base = makeDraft(overrides);
  return { ...base, properties: { encoding: 'UTF-8', skipSoapAction: false } as typeof base.properties };
}

function renderInspector(): void {
  render(
    <TooltipPrimitive.Provider>
      <HeadersInspector requestId="req-1" />
    </TooltipPrimitive.Provider>,
  );
}

function install(headers: readonly HeaderEntryWire[], overrides: Parameters<typeof makeDraft>[0] = {}): void {
  useProjectStore.setState({
    requests: { 'req-1': draft({ headers: [...headers], ...overrides }) },
    editRequest,
  } as never);
}

function computedNames(): string[] {
  return screen.getAllByTestId('soap-header-computed-row').map((row) => row.textContent ?? '');
}

describe('HeadersInspector (request)', () => {
  beforeEach(() => {
    editRequest.mockClear();
    useProblemsStore.setState({ items: [] });
    install([{ name: 'X-Trace', value: 'abc' }]);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the REST editor’s table, with the On and Description columns', () => {
    renderInspector();
    expect(screen.getByRole('grid', { name: 'Request headers' })).toBeDefined();
    expect(screen.getByTestId<HTMLInputElement>('soap-header-name').value).toBe('X-Trace');
    expect(screen.getByTestId<HTMLInputElement>('soap-header-enabled').checked).toBe(true);
    expect(screen.getByTestId('soap-header-description')).toBeDefined();
  });

  it('switches a header off by writing enabled: false, keeping the row', () => {
    renderInspector();
    fireEvent.click(screen.getByTestId('soap-header-enabled'));
    expect(editRequest).toHaveBeenCalledWith('req-1', {
      headers: [{ name: 'X-Trace', value: 'abc', enabled: false }],
    });
  });

  it('reads a header saved off as unchecked, and writes nothing extra for one that is on', () => {
    install([
      { name: 'X-Off', value: '1', enabled: false },
      { name: 'X-On', value: '2' },
    ]);
    renderInspector();
    const [off, on] = screen.getAllByTestId<HTMLInputElement>('soap-header-enabled');
    expect(off?.checked).toBe(false);
    expect(on?.checked).toBe(true);

    fireEvent.click(off!);
    expect(editRequest).toHaveBeenCalledWith('req-1', {
      headers: [
        { name: 'X-Off', value: '1' },
        { name: 'X-On', value: '2' },
      ],
    });
  });

  it('saves a description, and drops an emptied one', () => {
    renderInspector();
    const description = screen.getByTestId('soap-header-description');
    fireEvent.change(description, { target: { value: 'trace id' } });
    fireEvent.keyDown(description, { key: 'Enter' });
    expect(editRequest).toHaveBeenLastCalledWith('req-1', {
      headers: [{ name: 'X-Trace', value: 'abc', description: 'trace id' }],
    });
  });

  it('adds a header from the add row', () => {
    renderInspector();
    fireEvent.change(screen.getByTestId('soap-header-new-name'), { target: { value: 'X-Extra' } });
    expect(editRequest).toHaveBeenCalledWith('req-1', {
      headers: [
        { name: 'X-Trace', value: 'abc' },
        { name: 'X-Extra', value: '' },
      ],
    });
  });

  it('lists the headers the binding computes, greyed under the typed ones', () => {
    renderInspector();
    expect(computedNames()).toEqual([expect.stringContaining('Content-Type'), expect.stringContaining('SOAPAction')]);
  });

  it('drops a computed header a typed one replaces, case-insensitively, unless that row is off', () => {
    install([{ name: 'content-TYPE', value: 'text/plain' }]);
    renderInspector();
    expect(computedNames()).toEqual([expect.stringContaining('SOAPAction')]);
    cleanup();

    install([{ name: 'content-TYPE', value: 'text/plain', enabled: false }]);
    renderInspector();
    expect(computedNames()).toHaveLength(2);
  });

  it('shows this request’s unresolved expansions under the table', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'expansion:req-1',
          source: 'expansion',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'expansion-missing', message: 'Unresolved property ${#Project#nope} in header "X-Trace"' },
        },
      ],
    });
    renderInspector();

    expect(screen.getByText(/\$\{#Project#nope\}/)).toBeDefined();
  });
});

describe('computedSoapHeaders', () => {
  it('computes SOAP 1.1’s content type and quoted SOAPAction', () => {
    const request = draft({ headers: [], soapVersion: '1.1', soapAction: 'urn:Add' });
    expect(computedSoapHeaders(request).map((row) => [row.name, row.value])).toEqual([
      ['Content-Type', 'text/xml;charset=UTF-8'],
      ['SOAPAction', '"urn:Add"'],
    ]);
  });

  it('folds the action into SOAP 1.2’s content type', () => {
    const request = draft({ headers: [], soapVersion: '1.2', soapAction: 'urn:Add' });
    expect(computedSoapHeaders(request).map((row) => [row.name, row.value])).toEqual([
      ['Content-Type', 'application/soap+xml;charset=UTF-8;action="urn:Add"'],
    ]);
  });

  it('leaves the action out when the request skips it', () => {
    const base = draft({ headers: [], soapVersion: '1.1', soapAction: 'urn:Add' });
    const request = { ...base, properties: { ...base.properties, skipSoapAction: true } };
    expect(computedSoapHeaders(request).map((row) => row.name)).toEqual(['Content-Type']);
  });
});
