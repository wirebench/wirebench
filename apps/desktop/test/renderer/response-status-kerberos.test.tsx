/** The status line's authentication note: Kerberos is named only when a challenge actually carried a token. */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResponseStatus } from '../../src/renderer/features/request-editor/response-status.js';
import { makeExchange } from '../mocks/wire-fixtures.js';

afterEach(cleanup);

describe('the Kerberos note on the status line', () => {
  it('names Kerberos and the SPN after a challenge', () => {
    const exchange = makeExchange({ auth: { scheme: 'kerberos', challenged: true, attempts: 2, spn: 'HTTP/svc' } });
    render(<ResponseStatus exchange={exchange} />);
    expect(screen.getByTestId('auth-challenge-note').textContent).toBe(' · Authenticated with Kerberos as HTTP/svc');
  });

  it('omits the SPN when none is known', () => {
    const exchange = makeExchange({ auth: { scheme: 'kerberos', challenged: true, attempts: 2 } });
    render(<ResponseStatus exchange={exchange} />);
    expect(screen.getByTestId('auth-challenge-note').textContent).toBe(' · Authenticated with Kerberos');
  });

  it('shows no Kerberos note when the server never challenged (no token was sent)', () => {
    const exchange = makeExchange({ auth: { scheme: 'kerberos', challenged: false, attempts: 1, spn: 'HTTP/svc' } });
    render(<ResponseStatus exchange={exchange} />);
    expect(screen.queryByTestId('auth-challenge-note')).toBeNull();
  });

  it('keeps the existing note for other schemes', () => {
    const exchange = makeExchange({ auth: { scheme: 'basic', challenged: true, attempts: 2 } });
    render(<ResponseStatus exchange={exchange} />);
    expect(screen.getByTestId('auth-challenge-note').textContent).toBe(' · Authenticated after 401 challenge');
  });
});
