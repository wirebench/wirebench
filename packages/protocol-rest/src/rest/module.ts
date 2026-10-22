/** REST as a protocol module (spec §3). */
import { defineProtocol } from '#core/protocol/module';
import { restSecrets } from './secrets.js';
import { restMocking } from './mock.js';
import { restRun } from './run.js';
import { restScripting } from './scripting.js';
import { restStorage } from './storage.js';
import { webhookProjectFiles } from '../webhooks/storage.js';

/** The REST protocol: APIs, their folders and requests, and the project's webhook items. */
export const restProtocol = defineProtocol({
  kind: 'rest',
  feature: { id: 'rest', title: 'REST', default: true, stage: 'stable', requires: [] },
  storage: restStorage,
  projectFiles: webhookProjectFiles,
  secrets: restSecrets,
  run: restRun,
  scripting: restScripting,
  mock: restMocking,
});
