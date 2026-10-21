/**
 * The request pane's WS-Addressing inspector: whether this request sends `wsa:*` headers, what
 * they say, and — when it defines nothing of its own — the interface configuration it inherits.
 *
 * "Inherit from interface" is a real state, distinct from an explicitly disabled configuration:
 * a request that inherits follows the interface when that changes, and one that overrides does
 * not. While inheriting, the form shows the *effective* values greyed out, so what would go on
 * the wire is visible without having to break the inheritance to look.
 */

import { useEffect, useState } from 'react';
import { WsaFields } from '../../../components/wsa-fields.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProjectStore } from '../../../state/project.js';
import type { RequestPreflightResponse } from '../../../../shared/wire-types.js';
import type { WsaConfigWire } from '../../../../shared/kinds/soap/wire.js';

export interface WsaInspectorProps {
  readonly requestId: string;
}

export function WsaInspector({ requestId }: WsaInspectorProps) {
  const request = useProjectStore((state) => state.requests[requestId]);
  const interfaceWsa = useProjectStore((state) =>
    request === undefined ? undefined : state.interfaces[request.interfaceId]?.wsaConfig,
  );
  // A WSDL that only *offers* addressing (`wsp:Optional="true"`, no required assertion) does
  // not auto-enable — see `detectWsaDefaults` — but the user should still be told it is there.
  const wsdlOffersOptionalAddressing = useProjectStore(
    (state) => request !== undefined && state.interfaces[request.interfaceId]?.wsa?.optional === true,
  );
  const updateRequestWsa = useProjectStore((state) => state.updateRequestWsa);
  const interfaceName = useProjectStore((state) =>
    request === undefined ? undefined : state.interfaces[request.interfaceId]?.name,
  );
  const [effective, setEffective] = useState<RequestPreflightResponse['wsa'] | undefined>(undefined);
  const own = request?.wsa;

  // What the headers would actually say — the interface/request merge plus the Action/To
  // fallbacks — is main's answer, not something the renderer should recompute.
  useEffect(() => {
    let cancelled = false;
    void ipc()
      .request.preflight({ requestId })
      .then((result) => {
        if (!cancelled && result.ok) {
          setEffective(result.value.wsa);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, own, interfaceWsa]);

  if (request === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const inherit = own === undefined;
  const base: WsaConfigWire = own ?? interfaceWsa ?? { enabled: false };
  // While inheriting, the greyed fields hold what would be sent, the Action and To the interface leaves
  // to their defaults included, rather than blanks (#732 X10).
  const shown: WsaConfigWire =
    inherit && effective?.enabled === true
      ? {
          ...base,
          ...(base.action === undefined && effective.action !== undefined ? { action: effective.action } : {}),
          ...(base.to === undefined && effective.to !== undefined ? { to: effective.to } : {}),
        }
      : base;

  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <label className="flex items-center gap-2 text-fg-default">
        <input
          type="checkbox"
          data-testid="wsa-inherit"
          checked={inherit}
          onChange={(event) => {
            // Breaking inheritance copies the interface configuration across, so the first edit
            // changes one field rather than silently resetting every other one to a default.
            updateRequestWsa(requestId, event.target.checked ? null : { ...base });
          }}
        />
        <span className="text-xs">Inherit from interface</span>
      </label>
      {inherit && (
        <p data-testid="wsa-inherited-state" className="text-xs text-fg-subtle">
          WS-A is {base.enabled ? 'on' : 'off'} on {interfaceName ?? 'the interface'}
          {base.enabled && base.version !== undefined ? ` (${base.version})` : ''}.
        </p>
      )}

      <WsaFields
        config={shown}
        testIdPrefix="wsa"
        readOnly={inherit}
        onChange={(patch) => {
          updateRequestWsa(requestId, { ...base, ...patch });
        }}
      />

      {effective !== undefined && (
        <p data-testid="wsa-effective" className="border-t border-hairline pt-2 text-xs text-fg-subtle">
          {effective.enabled
            ? `Sends Action ${effective.action ?? '—'}, To ${effective.to ?? '—'}, MessageID ${effective.messageId ?? '—'}`
            : 'WS-Addressing is off for this request; no wsa:* headers are sent.'}
        </p>
      )}

      {effective?.enabled !== true && wsdlOffersOptionalAddressing && (
        <p data-testid="wsa-offers-optional" className="text-xs text-fg-subtle">
          WSDL offers WS-Addressing (optional)
        </p>
      )}
    </div>
  );
}
