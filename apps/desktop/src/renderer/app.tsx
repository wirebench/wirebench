import { useEffect, useState } from 'react';

type VersionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly version: string; readonly electron: string; readonly node: string }
  | { readonly status: 'error'; readonly code: string };

/** The Wirebench desktop shell: title plus the app/Electron/Node version fetched over IPC. */
export function App(): React.JSX.Element {
  const [state, setState] = useState<VersionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void window.wirebench.app.version(undefined).then((result) => {
      if (cancelled) {
        return;
      }
      setState(
        result.ok
          ? { status: 'ready', version: result.value.version, electron: result.value.electron, node: result.value.node }
          : { status: 'error', code: result.error.code },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Wirebench</h1>
      {state.status === 'loading' && <p>Loading version…</p>}
      {state.status === 'ready' && (
        <p>
          v{state.version} · Electron {state.electron} · Node {state.node}
        </p>
      )}
      {state.status === 'error' && <p>Failed to load version: {state.code}</p>}
    </main>
  );
}
