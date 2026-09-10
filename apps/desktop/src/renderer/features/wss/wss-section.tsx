/**
 * The WS-Security sidebar view. Keystores is the only section with behaviour today; Outgoing
 * and Incoming are placeholders the WS-Security tasks (37–40) fill in, kept here so the view's
 * shape — and the order the spec lists these in — is settled before they arrive.
 */

import { KeystoresView } from './keystores-view.js';

function Placeholder({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <section className="shrink-0 border-t border-hairline px-2 py-2">
      <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">{title}</h3>
      <p className="mt-1 text-sm text-fg-faint">{body}</p>
    </section>
  );
}

/** The sidebar body for the `wss` view. */
export function WssSection() {
  return (
    <div data-testid="wss-section" className="min-h-0 flex-1 overflow-auto">
      <KeystoresView />
      <Placeholder title="Outgoing" body="Signing and encryption for outgoing messages." />
      <Placeholder title="Incoming" body="Decryption and signature verification for responses." />
    </div>
  );
}
