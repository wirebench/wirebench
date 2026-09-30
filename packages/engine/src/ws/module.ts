/**
 * WebSocket as a protocol module (spec §3). A run cannot send a WebSocket request yet, so the run
 * facet offers no request and only answers why one cannot be a sequence step.
 */
import { defineProtocol } from '../protocol/module.js';
import type { ProtocolRun, SelectedBase } from '../protocol/module.js';
import type { SentRequest } from '../run/run.js';
import { findInTree } from '../run/tree.js';
import type { RequestScriptTypes } from '../script/request-scripts.js';
import type { SecretNeed } from '../secrets/env-names.js';

const NOT_RUNNABLE = 'A run cannot send a WebSocket request';

/** WebSocket's run facet: nothing to select, so nothing ever reaches `send`. */
const wsRun: ProtocolRun<SelectedBase> = {
  groups() {
    return [];
  },

  whyNotRunnable(project, requestId) {
    return project.wsApis.some((api) => findInTree(api, requestId) !== undefined)
      ? 'A WebSocket request cannot be a sequence step'
      : undefined;
  },

  send(): Promise<SentRequest> {
    return Promise.reject(new Error(NOT_RUNNABLE));
  },

  scriptTypes(): Promise<RequestScriptTypes> {
    return Promise.reject(new Error(NOT_RUNNABLE));
  },

  secretNeeds(): readonly SecretNeed[] {
    throw new Error(NOT_RUNNABLE);
  },
};

/** The WebSocket protocol: APIs, their folders and their saved requests. */
export const wsProtocol = defineProtocol({
  kind: 'websocket',
  feature: { id: 'websocket', title: 'WebSocket', default: true, stage: 'stable', requires: [] },
  run: wsRun,
});
