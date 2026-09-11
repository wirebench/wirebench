/**
 * The WS-Security sidebar view: Keystores, Outgoing configurations, and an Incoming placeholder
 * the remaining WS-Security tasks (39–40) fill in.
 */

import { KeystoresView } from './keystores-view.js';
import { OutgoingConfigEditor } from './outgoing-config-editor.js';

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
      <OutgoingConfigEditor />
      <Placeholder title="Incoming" body="Decryption and signature verification for responses." />
    </div>
  );
}
