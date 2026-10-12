import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuthFields } from '../../src/renderer/components/auth-fields.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { AuthConfigWire } from '../../src/shared/wire-base.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const HS256: AuthConfigWire = {
  type: 'jwt',
  algorithm: 'HS256',
  claims: '{"sub":"svc"}',
  issuedAt: true,
  expiresInSeconds: 300,
  jwtId: false,
  in: 'header',
};

beforeEach(() => {
  installWirebenchApi();
  useProjectStore.setState({
    keystores: [{ id: 'ks-1', name: 'Signing key', path: 'k.pem', type: 'pem', projectId: 'p1' }],
  });
});

afterEach(() => {
  cleanup();
});

/** The last configuration the form produced. */
function last(onChange: ReturnType<typeof vi.fn>): AuthConfigWire {
  return onChange.mock.calls.at(-1)?.[0] as AuthConfigWire;
}

describe('AuthFields — client-signed JWT', () => {
  it('offers JWT and starts it from usable defaults', () => {
    const onChange = vi.fn();
    render(<AuthFields scope="Request" inheritable auth={{ type: 'inherit' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Request authentication type'), { target: { value: 'jwt' } });
    expect(last(onChange)).toEqual({
      type: 'jwt',
      algorithm: 'HS256',
      claims: '{\n  "sub": ""\n}',
      issuedAt: true,
      expiresInSeconds: 300,
      jwtId: false,
      in: 'header',
    });
  });

  it('asks for a secret for HMAC and for a keystore for the others, dropping what no longer applies', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AuthFields scope="Request" auth={{ ...HS256, secretRef: 'sec_1' }} onChange={onChange} />,
    );
    expect(screen.getByText('Secret')).toBeTruthy();
    expect(screen.queryByLabelText('Request signing key')).toBeNull();

    fireEvent.change(screen.getByLabelText('Request JWT algorithm'), { target: { value: 'RS256' } });
    const rs = last(onChange);
    expect(rs).toMatchObject({ algorithm: 'RS256' });
    expect('secretRef' in rs).toBe(false);

    rerender(<AuthFields scope="Request" auth={rs} onChange={onChange} />);
    expect(screen.queryByText('Secret')).toBeNull();
    fireEvent.change(screen.getByLabelText('Request signing key'), { target: { value: 'ks-1' } });
    expect(last(onChange)).toMatchObject({ algorithm: 'RS256', keystoreRef: 'ks-1' });
  });

  it('says when the claims or the header are not a JSON object', () => {
    const onChange = vi.fn();
    const { rerender } = render(<AuthFields scope="Request" auth={HS256} onChange={onChange} />);
    expect(screen.queryByText('The claims must be a JSON object.')).toBeNull();
    fireEvent.change(screen.getByLabelText('Request JWT claims'), { target: { value: '{"sub":' } });
    expect(last(onChange)).toMatchObject({ claims: '{"sub":' });
    rerender(<AuthFields scope="Request" auth={{ ...HS256, claims: '{"sub":', header: '[1]' }} onChange={onChange} />);
    expect(screen.getByText('The claims must be a JSON object.')).toBeTruthy();
    expect(screen.getByText('The header must be a JSON object.')).toBeTruthy();
  });

  it('clears the lifetime when it is emptied, so no exp is generated', () => {
    const onChange = vi.fn();
    render(<AuthFields scope="Request" auth={HS256} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Request JWT lifetime in seconds'), { target: { value: '' } });
    expect('expiresInSeconds' in last(onChange)).toBe(false);
  });

  it('shows the prefix for a header only, and says where the token goes', () => {
    const onChange = vi.fn();
    const { rerender } = render(<AuthFields scope="Request" auth={HS256} onChange={onChange} />);
    expect(screen.getByLabelText('Request JWT prefix')).toBeTruthy();
    expect(screen.getByText(/Authorization: Bearer <JWT>/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Request JWT location'), { target: { value: 'query' } });
    expect(last(onChange)).toMatchObject({ in: 'query' });
    rerender(<AuthFields scope="Request" auth={{ ...HS256, in: 'query' }} onChange={onChange} />);
    expect(screen.queryByLabelText('Request JWT prefix')).toBeNull();
    expect(screen.getByText(/\?access_token=<JWT>/)).toBeTruthy();
  });
});
