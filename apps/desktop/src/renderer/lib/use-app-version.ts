import { useEffect, useState } from 'react';

/**
 * The app version over IPC, for the status bar. `undefined` while loading or when the call
 * fails — the status bar simply omits it rather than showing an error in permanent chrome.
 */
export function useAppVersion(): string | undefined {
  const [version, setVersion] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.wirebench.app.version(undefined).then((result) => {
      if (!cancelled && result.ok) {
        setVersion(result.value.version);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
