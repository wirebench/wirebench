/** REST as a protocol module (spec §3). */
import { defineProtocol } from '../protocol/module.js';
import { restRun } from './run.js';
import { restScripting } from './scripting.js';
import { restStorage } from './storage.js';

/** The REST protocol: APIs, their folders and requests, and the project's webhook items. */
export const restProtocol = defineProtocol({
  kind: 'rest',
  feature: { id: 'rest', title: 'REST', default: true, stage: 'stable', requires: [] },
  storage: restStorage,
  run: restRun,
  scripting: restScripting,
});
