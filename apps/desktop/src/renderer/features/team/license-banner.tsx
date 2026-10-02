import { useEffect, useState } from 'react';
import { bannerText } from '../../state/license-format.js';
import { ipc } from '../../state/ipc-client.js';

/**
 * The grace and expiry banner (licensing spec §3.8). It reads the license itself, so it works in the
 * team dialog and once per server in Accounts. A member's read is refused, so a member sees nothing.
 */
export function LicenseBanner({ url }: { readonly url: string }) {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
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
  }, [url]);
  if (text === undefined) return null;
  return (
    <p
      data-testid="license-banner"
      role="status"
      className="mt-2 rounded-sm bg-surface-hover px-2 py-1 text-xs text-fg-default"
    >
      {text}
    </p>
  );
}
