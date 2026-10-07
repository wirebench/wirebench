/**
 * The `wss.*` IPC channels: the three operations that write WS-Security into the envelope
 * *text* the editor holds, as opposed to `request.wssOutgoingRef`, which is applied at send
 * time and never touches the saved envelope.
 *
 * One rule governs all three: every envelope they return goes through `redactXml`, so a
 * `wsse:Password` comes back masked. What these produce is about to be pasted into the editor
 * — and therefore autosaved into a project file — and a secret must never land there. The real
 * password is substituted by the send path alone, inside main.
 *
 * `wss.policyStatus` sits beside them and writes nothing: it judges the request against the
 * WS-SecurityPolicy its WSDL attaches (#58).
 */

import { channels } from '../../shared/ipc.js';
import { redactXml } from '../redact.js';
import type { ProjectRouter } from '../project-router.js';
import type { WssEntryWire, WssPolicyStatusResponse } from '../../shared/wire-types.js';
import { checkWssPolicy, describeWssPolicy, proposeWssEntries, WssError } from '@wirebench/engine';
import type { WssEntry, WssPolicy } from '@wirebench/engine';
import { registerHandler } from './register.js';

/** What the `wss.*` channels need; a stub stands in for it in tests. */
export interface WssChannelDeps {
  readonly project: Pick<
    ProjectRouter,
    'previewOutgoingWss' | 'insertWssEntry' | 'removeOutgoingWssFrom' | 'wssPolicyInputs'
  >;
}

/** The wire entry as the engine's model, with `undefined` optionals stripped for exactOptionalPropertyTypes. */
function toEngineEntry(entry: WssEntryWire, passwordRef?: string): WssEntry {
  if (entry.kind === 'unknown') {
    // An opaque entry exists only inside a stored list; there is nothing here to apply.
    throw new WssError(
      'wss-entry-unsupported',
      `The "${entry.originalKind}" WS-Security entry cannot be applied by this build.`,
    );
  }
  if (entry.kind === 'username-token') {
    const { passwordRef: own, ...rest } = entry;
    const ref = own ?? passwordRef;
    return { ...rest, ...(ref !== undefined ? { passwordRef: ref } : {}) };
  }
  if (entry.kind === 'signature') {
    const { alias, keyPasswordRef, parts, ...rest } = entry;
    return {
      ...rest,
      parts: parts.map(({ token, ...part }) => ({ ...part, ...(token === true ? { token } : {}) })),
      ...(alias !== undefined ? { alias } : {}),
      ...(keyPasswordRef !== undefined ? { keyPasswordRef } : {}),
    };
  }
  if (entry.kind === 'encryption') {
    const { alias, ...rest } = entry;
    return { ...rest, ...(alias !== undefined ? { alias } : {}) };
  }
  if (entry.kind === 'timestamp') {
    return entry;
  }
  // issued-token and saml-token: passed on as the editor wrote them. Only the wire schema has
  // checked their shape; nothing checks them against the engine schema — on the stored path either,
  // where `toWssOutgoingRef` stores entries unvalidated and `toWssEntry` passes one that fails the
  // engine schema through as an unknown kind. A bad entry is refused when it is applied.
  return entry as unknown as WssEntry;
}

/**
 * The policy panel's status for one request: the engine's summary, check and proposal over what
 * main holds. The wire policy is the engine's `WssPolicy` field for field (only zod types its
 * optionals `T | undefined`), and the proposed entries are plain data the wire schema accepts.
 */
export function wssPolicyStatus(inputs: ReturnType<ProjectRouter['wssPolicyInputs']>): WssPolicyStatusResponse {
  if (inputs === undefined) {
    return {};
  }
  const policy = inputs.policy as WssPolicy;
  const check = checkWssPolicy(policy, inputs.entries, inputs.endpoint);
  const proposal = proposeWssEntries(policy);
  return {
    status: {
      lines: [...describeWssPolicy(policy)],
      satisfied: check.satisfied,
      results: [...check.results],
      proposal: structuredClone(proposal.entries) as WssEntryWire[],
      notes: [...policy.notes, ...proposal.notes.filter((note) => !policy.unsupported.includes(note))],
    },
  };
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

  registerHandler(channels.wss.policyStatus, (request) =>
    Promise.resolve(wssPolicyStatus(deps.project.wssPolicyInputs(request.requestId))),
  );

  registerHandler(channels.wss.removeOutgoing, (request) =>
    Promise.resolve({ envelopeXml: deps.project.removeOutgoingWssFrom(request.requestId, request.envelopeXml) }),
  );
}
