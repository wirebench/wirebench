/** WebSocket as a protocol module (spec §3). */
import { defineProtocol } from '../protocol/module.js';
import { wsRun } from './run.js';
import { wsStorage } from './storage.js';

/** The WebSocket protocol: APIs, their folders and their saved requests. */
export const wsProtocol = defineProtocol({
  kind: 'websocket',
  feature: { id: 'websocket', title: 'WebSocket', default: true, stage: 'stable', requires: [] },
  storage: wsStorage,
  run: wsRun,
});
