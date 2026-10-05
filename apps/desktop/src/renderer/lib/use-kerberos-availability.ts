import { useEffect, useState } from 'react';

export interface KerberosAvailabilityView {
  readonly available: boolean;
  readonly reason?: string | undefined;
  readonly platform: 'win32' | 'darwin' | 'linux';
}

const UNCHECKED: KerberosAvailabilityView = {
  available: false,
  reason: 'Kerberos availability could not be checked.',
  platform: 'linux',
};

let inFlight: Promise<KerberosAvailabilityView | undefined> | undefined;

/** One IPC call shared by every picker on screen. Settles to unavailable when the call fails. */
function ask(): Promise<KerberosAvailabilityView | undefined> {
  inFlight ??= (async () => {
    try {
      const call = window.wirebench?.auth?.kerberosAvailability;
      if (call === undefined) return undefined;
      const result = await call(undefined);
      return result.ok ? result.value : UNCHECKED;
    } catch {
      return UNCHECKED;
    }
  })();
  return inFlight;
}

/** For tests: forget the cached answer. */
export function resetKerberosAvailability(): void {
  inFlight = undefined;
}

/** Asked once per renderer; undefined until main answers. */
export function useKerberosAvailability(): KerberosAvailabilityView | undefined {
  const [value, setValue] = useState<KerberosAvailabilityView | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void ask().then((view) => {
      if (!cancelled) setValue(view);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}
