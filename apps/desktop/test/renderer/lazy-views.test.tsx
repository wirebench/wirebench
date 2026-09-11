/**
 * What a code-split view does when its chunk cannot be fetched.
 *
 * The happy path is covered wherever each view is tested; this file covers the failure the
 * split boundary itself owns — an `import()` that rejects, which before the error boundary
 * blanked the pane and re-threw on every render.
 */
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { splitView } from '../../src/renderer/features/request-editor/views/lazy-views.js';

function Loaded(): React.JSX.Element {
  return <p>the view</p>;
}

describe('splitView', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the component once its chunk resolves', async () => {
    const { Component } = splitView<Record<string, never>>(() => Promise.resolve(Loaded));
    render(
      <Suspense fallback={<p>loading</p>}>
        <Component />
      </Suspense>,
    );

    expect(await screen.findByText('the view')).toBeDefined();
  });

  it('shows a retryable message instead of blanking the pane when the chunk fails', async () => {
    // The boundary logs the failure; keep the test output clean without losing the assertion
    // that it is reported at all.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let attempts = 0;
    const { Component } = splitView<Record<string, never>>(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('chunk 404')) : Promise.resolve(Loaded);
    });

    render(
      <Suspense fallback={<p>loading</p>}>
        <Component />
      </Suspense>,
    );

    expect(await screen.findByText('Could not load this view.')).toBeDefined();
    expect(logged).toHaveBeenCalled();
    // The failure is cached, not retried on every render: one import so far.
    expect(attempts).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('the view')).toBeDefined();
    await waitFor(() => {
      expect(attempts).toBe(2);
    });
  });
});
