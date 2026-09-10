import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FaultOverview } from '../../src/renderer/features/request-editor/views/fault-overview.js';
import type { FaultWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

describe('FaultOverview', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a SOAP 1.1 fault: code, reason, actor', () => {
    const fault: FaultWire = {
      version: '1.1',
      code: 'soapenv:Server',
      subcodes: [],
      reason: 'Simulated fault',
      actor: 'http://example.com/actor',
    };
    render(<FaultOverview fault={fault} />);

    expect(screen.getByText('SOAP 1.1')).toBeDefined();
    expect(screen.getByText('soapenv:Server')).toBeDefined();
    expect(screen.getByText('Simulated fault')).toBeDefined();
    expect(screen.getByText('http://example.com/actor')).toBeDefined();
  });

  it('renders the SOAP 1.2 subcode chain', () => {
    const fault: FaultWire = {
      version: '1.2',
      code: 'soap:Sender',
      subcodes: ['m:MessageFormat', 'm:MissingField'],
      reason: 'Invalid message',
      role: 'http://example.com/role',
      node: 'http://example.com/node',
    };
    render(<FaultOverview fault={fault} />);

    expect(screen.getByText('SOAP 1.2')).toBeDefined();
    expect(screen.getByText(/m:MessageFormat → m:MissingField/)).toBeDefined();
    expect(screen.getByText('http://example.com/role')).toBeDefined();
    expect(screen.getByText('http://example.com/node')).toBeDefined();
  });

  it('renders the detail XML in a read-only editor when present', () => {
    const fault: FaultWire = {
      version: '1.1',
      code: 'soapenv:Server',
      subcodes: [],
      reason: 'Boom',
      detailXml: '<code>42</code>',
    };
    render(<FaultOverview fault={fault} />);

    const editor = screen.getByLabelText<HTMLTextAreaElement>('Fault detail XML');
    expect(editor.value).toContain('<code>42</code>');
  });

  it('omits the detail panel when there is no detail XML', () => {
    const fault: FaultWire = { version: '1.1', code: 'soapenv:Server', subcodes: [], reason: 'Boom' };
    render(<FaultOverview fault={fault} />);

    expect(screen.queryByLabelText('Fault detail XML')).toBeNull();
  });

  it('renders a URL in the reason text as a clickable external link', () => {
    const fault: FaultWire = {
      version: '1.1',
      code: 'soapenv:Server',
      subcodes: [],
      reason: 'See https://example.com/docs/fault for details',
    };
    render(<FaultOverview fault={fault} />);

    const link = screen.getByRole('link', { name: 'https://example.com/docs/fault' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs/fault');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});
