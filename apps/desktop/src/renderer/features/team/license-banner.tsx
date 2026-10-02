import { useEffect, useState } from 'react';
import type { LicenseStateWire } from '../../../shared/wire-types.js';
import { bannerText } from '../../state/license-format.js';
import { ipc } from '../../state/ipc-client.js';

/**
 * The grace and expiry banner (licensing spec §3.8). It reads the license itself, so it works in the
 * team dialog and once per server in Accounts. A member's read is refused, so a member sees nothing.
 * With `state` it shows that instead and does not fetch: the License tab passes its own, so an
 * install or removal there updates the banner at once.
 */
export function LicenseBanner({ url, state }: { readonly url: string; readonly state?: LicenseStateWire }) {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (state !== undefined) return;
    let live = true;
    setText(undefined);
    void ipc()
      .license.get({ url })
      .then((result) => {
        if (live && result.ok) setText(bannerText(result.value));
      });
    return () => {
      live = false;
    };
  }, [url, state === undefined]);
  const shown = state !== undefined ? bannerText(state) : text;
  if (shown === undefined) return null;
  return (
    <p
      data-testid="license-banner"
      role="status"
      className="mt-2 rounded-sm bg-surface-hover px-2 py-1 text-xs text-fg-default"
    >
      {shown}
    </p>
  );
}
