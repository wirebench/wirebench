import { useEffect, useState } from 'react';

export interface KerberosAvailabilityView {
  readonly available: boolean;
  readonly reason?: string | undefined;
  readonly platform: 'win32' | 'darwin' | 'linux';
}

/** Asked once per mount; undefined until main answers. */
export function useKerberosAvailability(): KerberosAvailabilityView | undefined {
  const [value, setValue] = useState<KerberosAvailabilityView | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void window.wirebench.auth.kerberosAvailability(undefined).then((result) => {
      if (!cancelled && result.ok) setValue(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}
