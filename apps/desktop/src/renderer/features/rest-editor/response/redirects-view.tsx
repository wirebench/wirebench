/**
 * The redirect hops a send followed, in order.
 *
 * The method-change note is the point of the tab: a 301, 302 or 303 turns a POST into a GET (the rule
 * browsers and curl follow), which means the request that finally arrived is not the one that was
 * written. A user debugging "my body vanished" needs to see exactly that.
 */
import { MethodBadge } from '../../rest-api/method-badge.js';
import { statusToneClass } from './status-line.js';
import type { RestExchangeSummary } from '../../../../shared/wire-types.js';

export interface RedirectsViewProps {
  readonly exchange: RestExchangeSummary;
}

/** The Redirects tab. */
export function RedirectsView({ exchange }: RedirectsViewProps) {
  const hops = exchange.http.redirects ?? [];

  if (hops.length === 0) {
    return (
      <p data-testid="rest-response-redirects" className="p-3 text-sm text-fg-subtle">
        This request was not redirected.
      </p>
    );
  }

  return (
    <div data-testid="rest-response-redirects" className="flex flex-col gap-1 overflow-auto p-2">
      <ol className="flex flex-col gap-1">
        {hops.map((hop, index) => (
          <li
            key={`${hop.url}:${String(index)}`}
            data-testid="rest-redirect-row"
            className="flex items-center gap-2 text-xs"
          >
            <span className={`w-10 shrink-0 font-mono font-medium ${statusToneClass(hop.status)}`}>{hop.status}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-fg-default" title={hop.url}>
              {hop.url}
            </span>
          </li>
        ))}
      </ol>
      <p className="flex items-center gap-1.5 px-1 text-xs text-fg-muted">
        Arrived as <MethodBadge method={exchange.method} />
        {exchange.methodChanged && (
          <span className="text-status-warning">— a redirect changed the method, so the body was not resent.</span>
        )}
      </p>
    </div>
  );
}
