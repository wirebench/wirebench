import type { KindModule } from '../kind-module.js';

export const wsKind = {
  kind: 'websocket',
  feature: { id: 'websocket', title: 'WebSocket', default: true, stage: 'stable', requires: [] },
  label: 'WebSocket',
  tabs: { request: 'ws-request', container: 'ws-api' },
  interactive: true,
} as const satisfies KindModule<'websocket'>;
