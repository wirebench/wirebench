/**
 * "Apply policy": stores the outgoing WS-Security configuration main proposed from the
 * WS-SecurityPolicy the WSDL attaches to a request's operation, and selects it for the request
 * (spec D4).
 *
 * The configuration goes through the same store actions the configuration editor uses, so it is
 * saved like any hand-made one, and nothing about it is special afterwards.
 */

import { showToast } from '../../components/toast.js';
import { useProjectStore } from '../../state/project.js';
import type { WssEntryWire } from '../../../shared/wire-types.js';

/** The name an applied policy's configuration gets. */
export function policyConfigName(operationName: string): string {
  return `${operationName} policy`;
}

/** What the user filled in on an entry, which a refreshed proposal must not throw away. */
function carried(from: WssEntryWire, into: WssEntryWire): WssEntryWire {
  if (from.kind === 'username-token' && into.kind === 'username-token') {
    return {
      ...into,
      username: from.username,
      ...(from.passwordRef !== undefined ? { passwordRef: from.passwordRef } : {}),
    };
  }
  if (from.kind === 'signature' && into.kind === 'signature') {
    return {
      ...into,
      keystoreRef: from.keystoreRef,
      ...(from.alias !== undefined ? { alias: from.alias } : {}),
      ...(from.keyPasswordRef !== undefined ? { keyPasswordRef: from.keyPasswordRef } : {}),
    };
  }
  if (from.kind === 'encryption' && into.kind === 'encryption') {
    return { ...into, keystoreRef: from.keystoreRef, ...(from.alias !== undefined ? { alias: from.alias } : {}) };
  }
  if (from.kind === 'issued-token' && into.kind === 'issued-token') {
    return {
      ...from,
      // The policy decides what is asked for and in which protocol version; the user decides who asks.
      tokenType: into.tokenType,
      soapVersion: into.soapVersion,
      trustVersion: into.trustVersion,
      stsUrl: into.stsUrl.length > 0 ? into.stsUrl : from.stsUrl,
    };
  }
  return into;
}

/**
 * The proposal, keeping what the user filled in on the configuration it refreshes: each proposed
 * entry takes the credentials and keystores of the first existing entry of its kind.
 *
 * @param existing the configuration's current entries
 * @param proposed the entries the policy proposes
 */
export function mergeProposal(existing: readonly WssEntryWire[], proposed: readonly WssEntryWire[]): WssEntryWire[] {
  return proposed.map((entry) => {
    const match = existing.find((candidate) => candidate.kind === entry.kind);
    return match === undefined ? entry : carried(match, entry);
  });
}

/**
 * Applies the request's operation policy: refreshes the configuration the request already selects
 * when it is the one an earlier Apply created, otherwise creates one; then selects it.
 *
 * @param requestId the request to secure
 * @param proposed the entries main proposed from its operation's policy
 */
export async function applyWssPolicy(requestId: string, proposed: readonly WssEntryWire[]): Promise<void> {
  const state = useProjectStore.getState();
  const request = state.requests[requestId];
  const projectId = state.projectOf[requestId];
  if (request === undefined || projectId === undefined) {
    return;
  }
  const name = policyConfigName(request.operationName);
  const current = state.wssOutgoing.find((config) => config.id === request.wssOutgoingRef && config.name === name);
  try {
    let configId: string;
    if (current === undefined) {
      configId = await state.addWssOutgoing(projectId, { name });
      await state.updateWssOutgoing(configId, { entries: [...proposed] });
    } else {
      configId = current.id;
      await state.updateWssOutgoing(configId, { entries: mergeProposal(current.entries, proposed) });
    }
    if (request.wssOutgoingRef !== configId) {
      state.updateRequest(requestId, { wssOutgoingRef: configId });
    }
    showToast(
      current === undefined ? `Created "${name}" from the WSDL policy` : `Refreshed "${name}" from the WSDL policy`,
    );
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}
