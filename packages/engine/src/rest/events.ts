/** What a REST send reports while it runs (spec §3.2): the response opening, then each event-stream row. */
import type { SseRow } from '../http/sse.js';

export type RestLiveEvent =
  | {
      readonly protocol: 'rest';
      readonly kind: 'open';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
    }
  | { readonly protocol: 'rest'; readonly kind: 'row'; readonly row: SseRow };

/** This protocol's member of the unions over every composed protocol (package split spec §3.4). */
declare module '../protocol/unions.js' {
  interface LiveEvents {
    rest: RestLiveEvent;
  }
}
