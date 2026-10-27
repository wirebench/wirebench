import type { HistoryEntryWire } from '@shared/wire-types.js';
import { openRequestTab } from '../../features/request-editor/request-actions.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { ipc } from '../../state/ipc-client.js';
import type { KindHistory, KindRequests, KindSearch } from '../renderer-kind.js';
import { revealSoapMatch } from './search.js';

export const soapRequests: KindRequests = {
  open: openRequestTab,
  exists: (requestId, project) => project.requests[requestId] !== undefined,
};

function SoapHistoryBadge({ entry, place }: { readonly entry: HistoryEntryWire; readonly place: 'row' | 'header' }) {
  // A compact version badge: "SOAP 1.1" in a fixed 48 px column cut the row short (#732 X12).
  return place === 'row' ? (
    <span
      data-testid="history-soap-version"
      title={entry.soapVersion === 'none' ? 'SOAP' : `SOAP ${entry.soapVersion}`}
      className="shrink-0 rounded-sm bg-surface-hover px-1 font-mono text-fg-subtle"
    >
      {entry.soapVersion === 'none' ? 'SOAP' : entry.soapVersion}
    </span>
  ) : (
    <span className="text-xs text-fg-faint">SOAP</span>
  );
}

export const soapHistory: KindHistory = {
  Badge: SoapHistoryBadge,
  canResend: () => true,
  resend: (id) => ipc().history.resend({ id }),
  current: (requestId) => {
    const current = useExchangesStore.getState().byRequest[requestId]?.exchange;
    return current === undefined ? undefined : { label: 'Current', body: current.response?.envelopeXml ?? '' };
  },
};

export const soapSearch: KindSearch = { reveal: revealSoapMatch };
