/**
 * The redirect hops a send followed, in order.
 *
 * The method-change note is the point of the tab: a 301, 302 or 303 turns a POST into a GET (the rule
 * browsers and curl follow), which means the request that finally arrived is not the one that was
 * written. A user debugging "my body vanished" needs to see exactly that.
 *
 * Takes the `http` projection both protocols share rather than a REST summary, so the console's HTTP
 * Log can show hops for a SOAP exchange too; the arrival note needs the summary's `method` and
 * `methodChanged`, which only a REST caller has, and is omitted without them.
 */
import { MethodBadge } from '../../rest-api/method-badge.js';
import { statusToneClass } from './status-line.js';
import type { HttpExchangeWire } from '../../../../shared/wire-types.js';

export interface RedirectsViewProps {
  readonly http: HttpExchangeWire;
  /** The method the request arrived as, when the caller knows it. */
  readonly method?: string;
  /** A redirect turned the request into a `GET`; only a REST summary reports it. */
  readonly methodChanged?: boolean;
}

/** The Redirects tab. */
export function RedirectsView({ http, method, methodChanged = false }: RedirectsViewProps) {
  const hops = http.redirects;

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
      {method !== undefined && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-fg-muted">
          Arrived as <MethodBadge method={method} className="w-auto" />
          {methodChanged && (
            <span className="text-status-warning">— a redirect changed the method, so the body was not resent.</span>
          )}
        </p>
      )}
    </div>
  );
}
