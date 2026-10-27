/**
 * What clicking a search result does: open the thing that matched, at the place it matched. The
 * match's kind decides (spec §6.1): SOAP reveals the range or line, the others open the request.
 * A REST match's range is not revealed: a REST request's searchable text is assembled from its
 * URL and tables, so an offset into it points at no single editor.
 */
import type { SearchMatchWire } from '@shared/wire-base.js';
import { rendererKind } from '../../kinds/index.js';

/** Opens whatever `match` points at. A match with no protocol predates the other kinds and is SOAP. */
export function revealSearchMatch(match: SearchMatchWire): void {
  const kind = rendererKind(match.protocol ?? 'soap');
  if (kind.search.reveal !== undefined) {
    kind.search.reveal(match);
    return;
  }
  if (match.requestId !== undefined) {
    kind.requests.open(match.requestId, match.requestName);
  }
}
