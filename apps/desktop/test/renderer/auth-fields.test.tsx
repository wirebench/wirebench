import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthFields } from '../../src/renderer/components/auth-fields.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { SOAP_AUTH_TYPES, asSoapAuth } from '../../src/renderer/components/auth-fields.js';
import type { AuthConfigWire, EndpointAuthWire } from '../../src/shared/wire-types.js';

afterEach(() => {
  cleanup();
});

describe('AuthFields', () => {
  it('clearing the password drops passwordRef entirely rather than setting it to undefined', () => {
    installWirebenchApi();
    const onChange = vi.fn();
    const auth: EndpointAuthWire = { type: 'basic', username: 'ada', passwordRef: 'ref-old' };
    render(<AuthFields scope="Endpoint" auth={auth} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const sent = onChange.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('passwordRef' in sent).toBe(false);
    expect(sent).toEqual({ type: 'basic', username: 'ada' });
  });

  it('flushes an unsaved-but-typed password on unmount', async () => {
    installWirebenchApi({ secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-flushed' } }) } });
    const onChange = vi.fn();
    const auth: EndpointAuthWire = { type: 'basic', username: 'ada' };
    const { unmount } = render(<AuthFields scope="Endpoint" auth={auth} onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Endpoint password'), 'hunter2');
    unmount();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ type: 'basic', username: 'ada', passwordRef: 'ref-flushed' });
    });
  });

  it('offers every scheme, and Inherit only where there is something above to inherit from', () => {
    installWirebenchApi();
    const { rerender } = render(<AuthFields scope="API" auth={undefined} onChange={vi.fn()} />);

    const options = () =>
      [...screen.getByLabelText(/authentication type/).querySelectorAll('option')].map((option) => option.textContent);
    expect(options()).toEqual(['Not configured', 'None', 'Basic', 'NTLM', 'Bearer token', 'API key', 'OAuth2']);

    rerender(<AuthFields scope="Request" inheritable auth={undefined} onChange={vi.fn()} />);
    expect(options()?.[0]).toBe('Inherit');
  });

  it('offers a SOAP owner all six schemes but never Inherit', () => {
    installWirebenchApi();
    render(<AuthFields scope="Endpoint" types={SOAP_AUTH_TYPES} auth={undefined} onChange={vi.fn()} />);

    const options = [...screen.getByLabelText(/authentication type/).querySelectorAll('option')].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(['Not configured', 'None', 'Basic', 'NTLM', 'Bearer token', 'API key', 'OAuth2']);
  });

  it('passes the six SOAP schemes through and maps inherit to null', () => {
    const six: AuthConfigWire[] = [
      { type: 'none' },
      { type: 'basic', username: 'ada' },
      { type: 'ntlm', domain: 'D' },
      { type: 'bearer', tokenRef: 'ref-1' },
      { type: 'api-key', name: 'X-Key', in: 'query', valueRef: 'ref-2' },
      { type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://t', clientId: 'c', scopes: [] },
    ];
    for (const auth of six) {
      expect(asSoapAuth(auth)).toEqual(auth);
    }
    // Unreachable through a SOAP form — the offer has no Inherit — but the direction matters.
    expect(asSoapAuth({ type: 'inherit' })).toBeNull();
    expect(asSoapAuth(null)).toBeNull();
  });

  it('starts an inheritable owner at inherit rather than clearing it', async () => {
    installWirebenchApi();
    const onChange = vi.fn();
    render(<AuthFields scope="Request" inheritable auth={{ type: 'basic' }} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText(/authentication type/), 'inherit');

    expect(onChange).toHaveBeenCalledWith({ type: 'inherit' });
  });

  describe('the Bearer form', () => {
    it('holds the token as a ref and names the header it will send', async () => {
      installWirebenchApi({ secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-tok' } }) } });
      const onChange = vi.fn();
      render(<AuthFields scope="Request" auth={{ type: 'bearer' }} onChange={onChange} />);

      await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
      await userEvent.type(screen.getByLabelText('Request token'), 'abc123');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith({ type: 'bearer', tokenRef: 'ref-tok' });
      });
      expect(screen.getByText(/Authorization: Bearer/)).toBeTruthy();
    });

    it('takes a scheme of its own, which the hint then reflects', async () => {
      installWirebenchApi();
      const onChange = vi.fn();
      const { rerender } = render(<AuthFields scope="Request" auth={{ type: 'bearer' }} onChange={onChange} />);

      await userEvent.type(screen.getByLabelText('Request scheme'), 'Token');

      expect(onChange).toHaveBeenCalledWith({ type: 'bearer', scheme: 'T' });
      rerender(<AuthFields scope="Request" auth={{ type: 'bearer', scheme: 'Token' }} onChange={onChange} />);
      expect(screen.getByText(/Authorization: Token/)).toBeTruthy();
    });
  });

  describe('the API-key form', () => {
    it('starts with a name and a header, neither of which has a sensible empty default', async () => {
      installWirebenchApi();
      const onChange = vi.fn();
      render(<AuthFields scope="API" auth={undefined} onChange={onChange} />);

      await userEvent.selectOptions(screen.getByLabelText(/authentication type/), 'api-key');

      expect(onChange).toHaveBeenCalledWith({ type: 'api-key', name: '', in: 'header' });
    });

    it('switches the key to a query parameter', async () => {
      installWirebenchApi();
      const onChange = vi.fn();
      render(
        <AuthFields scope="API" auth={{ type: 'api-key', name: 'X-Api-Key', in: 'header' }} onChange={onChange} />,
      );

      await userEvent.selectOptions(screen.getByLabelText('API api key location'), 'query');

      expect(onChange).toHaveBeenCalledWith({ type: 'api-key', name: 'X-Api-Key', in: 'query' });
    });

    it('holds the key value as a ref', async () => {
      installWirebenchApi({ secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-key' } }) } });
      const onChange = vi.fn();
      render(
        <AuthFields scope="API" auth={{ type: 'api-key', name: 'X-Api-Key', in: 'header' }} onChange={onChange} />,
      );

      await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
      await userEvent.type(screen.getByLabelText('API value'), 'secret-key');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith({
          type: 'api-key',
          name: 'X-Api-Key',
          in: 'header',
          valueRef: 'ref-key',
        });
      });
    });
  });

  describe('the OAuth2 form', () => {
    const CLIENT_CREDENTIALS: AuthConfigWire = {
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://issuer.test/token',
      clientId: 'app',
      scopes: ['read', 'write'],
      clientAuth: 'basic',
      pkce: true,
    };

    it('starts from the defaults a token request needs', async () => {
      installWirebenchApi();
      const onChange = vi.fn();
      render(<AuthFields scope="API" auth={undefined} onChange={onChange} />);

      await userEvent.selectOptions(screen.getByLabelText(/authentication type/), 'oauth2');

      expect(onChange).toHaveBeenCalledWith({
        type: 'oauth2',
        grant: 'client-credentials',
        tokenUrl: '',
        clientId: '',
        scopes: [],
        clientAuth: 'basic',
        pkce: true,
      });
    });

    it('shows the authorize URL and PKCE only for the code grant', () => {
      installWirebenchApi();
      const { rerender } = render(<AuthFields scope="API" auth={CLIENT_CREDENTIALS} onChange={vi.fn()} />);

      // Client credentials has no authorization request, so neither field means anything for it.
      expect(screen.queryByLabelText('API authorize url')).toBeNull();
      expect(screen.queryByLabelText('API pkce')).toBeNull();

      rerender(
        <AuthFields scope="API" auth={{ ...CLIENT_CREDENTIALS, grant: 'authorization-code' }} onChange={vi.fn()} />,
      );
      expect(screen.getByLabelText('API authorize url')).toBeTruthy();
      expect(screen.getByLabelText('API pkce')).toBeTruthy();
    });

    it('reads and writes scopes as the space-separated list a token request carries', async () => {
      installWirebenchApi();
      const onChange = vi.fn();
      render(<AuthFields scope="API" auth={CLIENT_CREDENTIALS} onChange={onChange} />);

      expect(screen.getByLabelText<HTMLInputElement>('API scopes').value).toBe('read write');

      await userEvent.clear(screen.getByLabelText('API scopes'));
      expect(onChange).toHaveBeenCalledWith({ ...CLIENT_CREDENTIALS, scopes: [] });
    });

    it('holds the client secret as a ref, never a value', async () => {
      installWirebenchApi({ secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-cs' } }) } });
      const onChange = vi.fn();
      render(<AuthFields scope="API" auth={CLIENT_CREDENTIALS} onChange={onChange} />);

      await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
      await userEvent.type(screen.getByLabelText('API client secret'), 's3cret');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith({ ...CLIENT_CREDENTIALS, clientSecretRef: 'ref-cs' });
      });
    });

    it('reserves a keychain slot when asked to remember the refresh token, and frees it again', async () => {
      const set = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-refresh' } });
      const remove = vi.fn().mockResolvedValue({ ok: true, value: { deleted: true } });
      installWirebenchApi({ secrets: { set, delete: remove } });
      const onChange = vi.fn();
      const { rerender } = render(<AuthFields scope="API" auth={CLIENT_CREDENTIALS} onChange={onChange} />);

      await userEvent.click(screen.getByTestId('auth-remember-refresh'));

      // An empty slot, so main can store a refresh token later without the project file changing.
      expect(set).toHaveBeenCalledWith({ value: '', label: 'OAuth2 refresh token' });
      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith({ ...CLIENT_CREDENTIALS, refreshTokenRef: 'ref-refresh' });
      });

      onChange.mockReset();
      rerender(
        <AuthFields scope="API" auth={{ ...CLIENT_CREDENTIALS, refreshTokenRef: 'ref-refresh' }} onChange={onChange} />,
      );
      await userEvent.click(screen.getByTestId('auth-remember-refresh'));

      const sent = onChange.mock.calls[0]?.[0] as Record<string, unknown>;
      expect('refreshTokenRef' in sent).toBe(false);
      await waitFor(() => {
        expect(remove).toHaveBeenCalledWith({ ref: 'ref-refresh' });
      });
    });

    it('renders the status panel it is given, under the fields', () => {
      installWirebenchApi();
      render(
        <AuthFields
          scope="API"
          auth={CLIENT_CREDENTIALS}
          onChange={vi.fn()}
          oauth2Status={<p data-testid="stub-status">status</p>}
        />,
      );

      expect(screen.getByTestId('stub-status')).toBeTruthy();
    });
  });

  describe('AuthFields for a definition fetch', () => {
    it('leaves out the preemptive box when asked, since such a fetch is always preemptive', () => {
      installWirebenchApi();
      const auth: AuthConfigWire = { type: 'basic', username: 'ada' };
      render(<AuthFields scope="Definition" auth={auth} onChange={vi.fn()} preemptiveOption={false} />);

      expect(screen.queryByLabelText('Definition preemptive')).toBeNull();
    });

    it('hands its owner a flush that stores a typed secret and answers the configuration with its reference', async () => {
      installWirebenchApi({ secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-flushed' } }) } });
      let flush: (() => Promise<AuthConfigWire | undefined>) | undefined;
      const auth: AuthConfigWire = { type: 'bearer' };
      render(
        <AuthFields
          scope="Definition"
          auth={auth}
          onChange={vi.fn()}
          registerFlush={(next) => {
            flush = next;
          }}
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
      await userEvent.type(screen.getByLabelText('Definition token'), 'tok');

      expect(await flush?.()).toEqual({ type: 'bearer', tokenRef: 'ref-flushed' });
    });
  });
});
