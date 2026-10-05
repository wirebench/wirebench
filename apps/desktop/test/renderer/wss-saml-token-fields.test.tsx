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

  it('keeps typed spaces in attribute values and parses them on blur', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    const withAttribute: SamlEntry = { ...formEntry, attributes: [{ name: 'groups', values: [''] }] };
    render(<SamlTokenFields entry={withAttribute} onChange={onChange} idPrefix="e0" />);
    const input = screen.getByLabelText<HTMLInputElement>('Attribute 1 values');
    fireEvent.change(input, { target: { value: 'Domain ' } });
    expect(input.value).toBe('Domain ');
    fireEvent.change(input, { target: { value: 'Domain Users, Ops' } });
    expect(input.value).toBe('Domain Users, Ops');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ attributes: [{ name: 'groups', values: ['Domain Users', 'Ops'] }] }),
    );
  });

  it('picks the issuer signature algorithm', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    const signing: SamlEntry = { ...formEntry, sign: { keystoreRef: 'ks1', signatureAlgorithm: 'rsa-sha256' } };
    render(<SamlTokenFields entry={signing} onChange={onChange} idPrefix="e0" />);
    const select = screen.getByLabelText<HTMLSelectElement>('Signature algorithm');
    expect(select.value).toBe('rsa-sha256');
    fireEvent.change(select, { target: { value: 'rsa-sha1' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sign: { keystoreRef: 'ks1', signatureAlgorithm: 'rsa-sha1' } }),
    );
  });

  it("edits an attribute's format and drops it when cleared", () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    const withAttribute: SamlEntry = { ...formEntry, attributes: [{ name: 'role', values: ['a'] }] };
    const { rerender } = render(<SamlTokenFields entry={withAttribute} onChange={onChange} idPrefix="e0" />);
    fireEvent.change(screen.getByLabelText('Attribute 1 format'), { target: { value: 'urn:nf' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ attributes: [{ name: 'role', nameFormat: 'urn:nf', values: ['a'] }] }),
    );
    const formatted: SamlEntry = { ...formEntry, attributes: [{ name: 'role', nameFormat: 'urn:nf', values: ['a'] }] };
    rerender(
      <TooltipPrimitive.Provider>
        <SamlTokenFields entry={formatted} onChange={onChange} idPrefix="e0" />
      </TooltipPrimitive.Provider>,
    );
    fireEvent.change(screen.getByLabelText('Attribute 1 format'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ attributes: [{ name: 'role', values: ['a'] }] }),
    );
  });

  it.each([
    ['Subject format', 'subjectFormat'],
    ['Audience', 'audience'],
    ['Authentication context', 'authnContext'],
  ] as const)('drops %s when it is cleared instead of writing an empty value', (label, key) => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={{ ...formEntry, [key]: 'urn:x' }} onChange={onChange} idPrefix="e0" />);
    fireEvent.change(screen.getByLabelText(label), { target: { value: '' } });
    const next = onChange.mock.calls.at(-1)?.[0] as SamlEntry;
    expect(next).not.toHaveProperty(key);
    expect(next.issuer).toBe('urn:i');
  });

  it('keeps the lifetime text while it is edited and commits a whole number on blur', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={formEntry} onChange={onChange} idPrefix="e0" />);
    const input = screen.getByLabelText<HTMLInputElement>('Lifetime');
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '90.7' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lifetimeSeconds: 90 }));
    expect(input.value).toBe('90');
  });

  it('commits a cleared or zero lifetime as one second', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={formEntry} onChange={onChange} idPrefix="e0" />);
    const input = screen.getByLabelText<HTMLInputElement>('Lifetime');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lifetimeSeconds: 1 }));
    fireEvent.change(input, { target: { value: '0.4' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lifetimeSeconds: 1 }));
  });
});
