import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { LiveCloseDialog, liveCloseTitle } from '../../src/renderer/shell/live-close-dialog.js';
import { useLiveCloseStore, type LiveCloseAnswer } from '../../src/renderer/shell/tab-close.js';

afterEach(() => {
  cleanup();
  useLiveCloseStore.setState({ question: undefined, resolve: undefined });
});

it('names the session, the sessions on one tab, or the sessions across tabs (S53)', () => {
  expect(liveCloseTitle({ sessions: 1, tabs: 1, name: 'alpha' })).toBe('Close the session on alpha?');
  expect(liveCloseTitle({ sessions: 2, tabs: 1, name: 'alpha' })).toBe('Close 2 sessions on alpha?');
  expect(liveCloseTitle({ sessions: 3, tabs: 2, name: '' })).toBe('Close 3 sessions in 2 tabs?');
});

it("answers Close with the Don't ask again box, and Cancel without (S53)", async () => {
  render(<LiveCloseDialog />);
  let answer: Promise<LiveCloseAnswer> | undefined;
  act(() => {
    answer = useLiveCloseStore.getState().ask({ sessions: 1, tabs: 1, name: 'alpha' });
  });
  expect(screen.getByText('Close the session on alpha?')).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Don't ask again"));
  fireEvent.click(screen.getByTestId('live-close-confirm'));
  await expect(answer).resolves.toEqual({ close: true, dontAskAgain: true });

  act(() => {
    answer = useLiveCloseStore.getState().ask({ sessions: 2, tabs: 2, name: '' });
  });
  fireEvent.click(screen.getByTestId('live-close-cancel'));
  await expect(answer).resolves.toEqual({ close: false, dontAskAgain: false });
});
