/** Every `agent-*` problem (hosted edition spec §18.2), one function each so a code is spelled once. */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** A wrong, used or expired pairing code: one answer for all three, so a guess learns nothing. */
export const pairingCodeInvalid = (): WirebenchError =>
  problem('agent-pairing-code-invalid', 'This pairing code is wrong or has expired. Ask for a new one.', 400);
/** Missing or malformed agent headers, a signature the pairing's key does not verify, or a stale timestamp. */
export const signatureInvalid = (): WirebenchError =>
  problem('agent-signature-invalid', 'The agent’s signature could not be verified.', 401);
/** An unknown, used or expired nonce, or one issued for another pairing. */
export const nonceInvalid = (): WirebenchError =>
  problem('agent-nonce-invalid', 'This tab’s nonce is not valid any more. Reload the tab.', 401);
/** No such pairing, or not this caller's. */
export const pairingUnknown = (): WirebenchError =>
  problem('agent-pairing-unknown', 'This machine is not paired with this server any more.', 404);
