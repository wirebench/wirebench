import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as baseRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { SamlTokenFields } from '../../src/renderer/features/wss/saml-token-fields.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { WssEntryWire } from '../../src/shared/wire-types.js';

type SamlEntry = Extract<WssEntryWire, { kind: 'saml-token' }>;

const xmlEntry: SamlEntry = { kind: 'saml-token', source: 'xml', xml: '<saml2:Assertion/>', expandProperties: false };
const formEntry: SamlEntry = {
  kind: 'saml-token',
  source: 'form',
  version: '2.0',
  issuer: 'urn:i',
  subject: '',
  confirmation: 'bearer',
  lifetimeSeconds: 300,
  attributes: [],
};

afterEach(cleanup);

// The icon buttons need the shell's TooltipProvider, which tests render outside.
function render(ui: ReactElement) {
  return baseRender(<TooltipPrimitive.Provider>{ui}</TooltipPrimitive.Provider>);
}

describe('SamlTokenFields', () => {
  it('switches from XML to a fresh form entry', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={xmlEntry} onChange={onChange} idPrefix="e0" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Form' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'form', version: '2.0', confirmation: 'bearer', attributes: [] }),
    );
  });

  it('warns that expanding properties breaks a signed assertion', () => {
    installWirebenchApi({});
    render(<SamlTokenFields entry={{ ...xmlEntry, expandProperties: true }} onChange={vi.fn()} idPrefix="e0" />);
    expect(screen.getByText(/breaks a signed assertion/i)).toBeTruthy();
  });

  it('edits the subject of a form entry', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={formEntry} onChange={onChange} idPrefix="e0" />);
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'alice' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subject: 'alice' }));
  });

  it('adds an attribute row', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={formEntry} onChange={onChange} idPrefix="e0" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ attributes: [{ name: '', values: [''] }] }));
  });

  it('turns issuer signing on with an empty keystore and RSA-SHA256', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={formEntry} onChange={onChange} idPrefix="e0" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sign as issuer' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sign: { keystoreRef: '', signatureAlgorithm: 'rsa-sha256' } }),
    );
  });
});
