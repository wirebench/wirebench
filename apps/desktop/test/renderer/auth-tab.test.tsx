/**
 * The REST request's Auth tab.
 *
 * The source line is what these tests are mostly about: a request that inherits and has nothing
 * above it goes out unauthenticated, and the tab has to say so rather than leaving the user to open
 * three other places to find out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RestAuthTab, authTypeLabel } from '../../src/renderer/features/rest-editor/auth-tab.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

beforeEach(() => {
  installWirebenchApi({
    oauth2: {
      status: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { state: 'none', redirectUri: 'http://127.0.0.1:1/callback' } }),
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('authTypeLabel', () => {
  it('names every scheme, and passes an unknown one through', () => {
    expect(authTypeLabel('api-key')).toBe('API key');
    expect(authTypeLabel('oauth2')).toBe('OAuth2');
    expect(authTypeLabel('something-new')).toBe('something-new');
  });
});

describe('RestAuthTab', () => {
  it('says the request goes out unauthenticated when nothing above it configures anything', () => {
    render(<RestAuthTab requestId="r1" auth={{ type: 'inherit' }} onChange={vi.fn()} />);

    expect(screen.getByTestId('rest-auth-source').textContent).toBe(
      'Inherited · nothing above this request configures credentials',
    );
  });

  it('names the level it inherits from, and what that level uses', () => {
    render(
      <RestAuthTab
        requestId="r1"
        auth={{ type: 'inherit' }}
        inheritedFrom={{ label: 'folder “Admin”', type: 'oauth2' }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('rest-auth-source').textContent).toBe('Inherited from folder “Admin” · OAuth2');
  });

  it('says when the request overrides its chain, and with what', () => {
    render(<RestAuthTab requestId="r1" auth={{ type: 'bearer', tokenRef: 'ref-1' }} onChange={vi.fn()} />);

    expect(screen.getByTestId('rest-auth-source').textContent).toBe('Set on this request · Bearer token');
  });

  it('edits every scheme in place — nothing is read-only here any more', async () => {
    const onChange = vi.fn();
    render(<RestAuthTab requestId="r1" auth={{ type: 'inherit' }} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText('Request authentication type'), 'bearer');

    expect(onChange).toHaveBeenCalledWith({ type: 'bearer' });
  });

  it('goes back to inheriting rather than to nothing', async () => {
    const onChange = vi.fn();
    render(<RestAuthTab requestId="r1" auth={{ type: 'basic', username: 'ada' }} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText('Request authentication type'), 'inherit');

    expect(onChange).toHaveBeenCalledWith({ type: 'inherit' });
  });

  it('shows the token panel for its own request only when the request itself uses OAuth2', () => {
    const { rerender } = render(
      <RestAuthTab
        requestId="r1"
        auth={{ type: 'inherit' }}
        inheritedFrom={{ label: 'the API', type: 'oauth2' }}
        onChange={vi.fn()}
      />,
    );
    // Inheriting OAuth2 means the *API* owns the token; the panel belongs where the config is.
    expect(screen.queryByTestId('oauth2-status')).toBeNull();

    rerender(
      <RestAuthTab
        requestId="r1"
        auth={{
          type: 'oauth2',
          grant: 'client-credentials',
          tokenUrl: '',
          clientId: '',
          scopes: [],
          clientAuth: 'basic',
          pkce: true,
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('oauth2-status')).toBeTruthy();
  });
});
