/**
 * The `wss.*` IPC channels: the three operations that write WS-Security into the envelope
 * *text* the editor holds, as opposed to `request.wssOutgoingRef`, which is applied at send
 * time and never touches the saved envelope.
 *
 * One rule governs all three: every envelope they return goes through `redactXml`, so a
 * `wsse:Password` comes back masked. What these produce is about to be pasted into the editor
 * — and therefore autosaved into a project file — and a secret must never land there. The real
 * password is substituted by the send path alone, inside main.
 */

import { channels } from '../../shared/ipc.js';
import { redactXml } from '../redact.js';
import type { ProjectService } from '../project-service.js';
import type { WssEntryWire } from '../../shared/wire-types.js';
import type { WssEntry } from '@wirebench/engine';
import { registerHandler } from './register.js';

/** What the `wss.*` channels need; a stub stands in for it in tests. */
export interface WssChannelDeps {
  readonly project: Pick<ProjectService, 'previewOutgoingWss' | 'insertWssEntry' | 'removeOutgoingWssFrom'>;
}

/** The wire entry as the engine's model. Signature/encryption pass through and fail loudly there. */
function toEngineEntry(entry: WssEntryWire, passwordRef?: string): WssEntry {
  if (entry.kind === 'username-token') {
    const { passwordRef: own, ...rest } = entry;
    const ref = own ?? passwordRef;
    return { ...rest, ...(ref !== undefined ? { passwordRef: ref } : {}) };
  }
  if (entry.kind === 'signature') {
    const { alias, keyPasswordRef, ...rest } = entry;
    return {
      ...rest,
      ...(alias !== undefined ? { alias } : {}),
      ...(keyPasswordRef !== undefined ? { keyPasswordRef } : {}),
    };
  }
  return entry;
}

/** Registers the `wss.*` channels. */
export function registerWssChannels(deps: WssChannelDeps): void {
  registerHandler(channels.wss.previewOutgoing, async (request) => {
    const envelopeXml = await deps.project.previewOutgoingWss(request.requestId, request.envelopeXml);
    return { envelopeXml: redactXml(envelopeXml) };
  });

  registerHandler(channels.wss.insertEntry, async (request) => {
    const entry = toEngineEntry(request.entry, request.passwordRef);
    const envelopeXml = await deps.project.insertWssEntry(request.requestId, entry, request.envelopeXml);
    return { envelopeXml: redactXml(envelopeXml) };
  });

  registerHandler(channels.wss.removeOutgoing, (request) =>
    Promise.resolve({ envelopeXml: deps.project.removeOutgoingWssFrom(request.requestId, request.envelopeXml) }),
  );
}
