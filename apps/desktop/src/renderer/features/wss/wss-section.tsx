/**
 * The WS-Security sidebar view: Keystores, Outgoing configurations and Incoming configurations.
 */

import { IncomingConfigEditor } from './incoming-config-editor.js';
import { KeystoresView } from './keystores-view.js';
import { OutgoingConfigEditor } from './outgoing-config-editor.js';

/** The sidebar body for the `wss` view. */
export function WssSection() {
  return (
    <div data-testid="wss-section" className="min-h-0 flex-1 overflow-auto">
      <KeystoresView />
      <OutgoingConfigEditor />
      <IncomingConfigEditor />
    </div>
  );
}
