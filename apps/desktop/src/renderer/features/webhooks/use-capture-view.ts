/**
 * One catch URL tab's view in main (webhook-capture §4.1): opened while the tab shows, closed when it
 * goes. `hooks.captures` events for the view keep the list current. An event that beats the `open`
 * reply is held until the view id is known.
 */
import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../../state/ipc-client.js';
import type { WebhooksServer } from '../../state/webhooks.js';
import type { CaptureSummaryWire, HooksCapturesEventWire } from '../../../shared/wire-types.js';

export interface Problem {
  readonly code: string;
  readonly message: string;
}

export type CaptureViewState =
  | { readonly phase: 'opening' }
  | {
      readonly phase: 'open';
      readonly viewId: string;
      readonly captures: readonly CaptureSummaryWire[];
      readonly more: boolean;
      readonly loadingOlder: boolean;
      /** A later fetch failed; the list keeps what it had (§6). */
      readonly error: Problem | undefined;
    }
  | { readonly phase: 'failed'; readonly error: Problem };

type Open = Extract<CaptureViewState, { phase: 'open' }>;

function applyEvent(state: Open, event: HooksCapturesEventWire): Open {
  switch (event.mode) {
    case 'prepend':
      return { ...state, captures: [...event.captures, ...state.captures], error: undefined };
    case 'replace':
      return { ...state, captures: event.captures, more: event.more, error: undefined };
    case 'error':
      return { ...state, error: event.error };
  }
}

export function useCaptureView(
  server: WebhooksServer | undefined,
  hookId: string,
): { readonly state: CaptureViewState; readonly retry: () => void; readonly older: () => void } {
  const [state, setState] = useState<CaptureViewState>({ phase: 'opening' });
  const [attempt, setAttempt] = useState(0);
  const url = server?.url;
  const workspaceId = server?.workspaceId;

  useEffect(() => {
    if (url === undefined || workspaceId === undefined) return;
    let viewId: string | undefined;
    let gone = false;
    const early: HooksCapturesEventWire[] = [];
    setState({ phase: 'opening' });
    const off = window.wirebench.on('hooks.captures', ((event: HooksCapturesEventWire) => {
      if (viewId === undefined) {
        early.push(event);
        return;
      }
      if (event.viewId !== viewId) return;
      setState((current) => (current.phase === 'open' ? applyEvent(current, event) : current));
    }) as (payload: unknown) => void);
    void ipc()
      .hooks.open({ url, workspaceId, hookId })
      .then((result) => {
        if (gone) {
          if (result.ok) void ipc().hooks.close({ viewId: result.value.viewId });
          return;
        }
        if (!result.ok) {
          setState({ phase: 'failed', error: result.error });
          return;
        }
        const opened = result.value;
        viewId = opened.viewId;
        let next: Open = {
          phase: 'open',
          viewId: opened.viewId,
          captures: opened.captures,
          more: opened.more,
          loadingOlder: false,
          error: undefined,
        };
        for (const event of early) if (event.viewId === opened.viewId) next = applyEvent(next, event);
        setState(next);
      });
    return () => {
      gone = true;
      off();
      if (viewId !== undefined) void ipc().hooks.close({ viewId });
    };
  }, [url, workspaceId, hookId, attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  // Recreated each render on purpose: it reads the state this render shows.
  const older = (): void => {
    const current = state;
    if (current.phase !== 'open' || !current.more || current.loadingOlder) return;
    setState({ ...current, loadingOlder: true });
    void ipc()
      .hooks.older({ viewId: current.viewId })
      .then((result) => {
        setState((latest) => {
          if (latest.phase !== 'open' || latest.viewId !== current.viewId) return latest;
          return result.ok
            ? {
                ...latest,
                captures: [...latest.captures, ...result.value.captures],
                more: result.value.more,
                loadingOlder: false,
              }
            : { ...latest, loadingOlder: false, error: result.error };
        });
      });
  };

  return { state, retry, older };
}
