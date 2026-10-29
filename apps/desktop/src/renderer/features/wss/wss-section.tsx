/**
 * The WS-Security sidebar view: Keystores, Outgoing configurations and Incoming configurations.
 */

import { placeholderMessage } from '../../kinds/placeholders.js';
import { useUiStore } from '../../state/ui.js';
import { hasCapability } from '../../lib/capabilities.js';
import { IncomingConfigEditor } from './incoming-config-editor.js';
import { KeystoresView } from './keystores-view.js';
import { OutgoingConfigEditor } from './outgoing-config-editor.js';

/** The sidebar body for the `wss` view. */
export function WssSection() {
  // The configurations are SOAP's: with SOAP off they are neither loaded nor saved, and stay on disk
  // as they are. The keystores are every kind's, so they stay.
  const soapOn = useUiStore((state) => state.enabledKinds.includes('soap'));
  return (
    <div data-testid="wss-section" className="min-h-0 flex-1 overflow-auto">
      {/* A keystore is a file on the machine, read there; a host without `files` has none to show. */}
      {hasCapability('files') && <KeystoresView />}
      {soapOn ? (
        <>
          <OutgoingConfigEditor />
          <IncomingConfigEditor />
        </>
      ) : (
        <p data-testid="wss-configs-switched-off" className="px-3 py-2 text-sm text-fg-subtle">
          {placeholderMessage('soap', 'feature-disabled')}: its WS-Security configurations are kept as they are.
        </p>
      )}
    </div>
  );
}
