/** What a REST send reports while it runs (spec §3.2): the response opening, then each event-stream row. */
import type { SseRow } from './sse.js';

export type RestLiveEvent =
  | {
      readonly protocol: 'rest';
      readonly kind: 'open';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
    }
  | { readonly protocol: 'rest'; readonly kind: 'row'; readonly row: SseRow };
