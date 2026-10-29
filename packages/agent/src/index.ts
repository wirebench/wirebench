/**
 * `@wirebench/agent`: the local agent a browser tab at a team's Wirebench Server pairs with (hosted edition
 * spec §18, ADR-0035). The CLI's `wirebench agent` and the desktop's main process embed it.
 */
export { AGENT_GROUP, BROWSER_CAPABILITIES, browserCapabilities, isAgentChannel } from './allowlist.js';
export { agentKeyFromPkcs8, bodySha256, generateAgentKey, signedHeaders, type AgentKey } from './keys.js';
export {
  AgentServerError,
  normaliseServerUrl,
  pair,
  redeemNonce,
  reportPort,
  unpair,
  type AgentFetch,
  type PairOptions,
  type PairResult,
  type UnpairOptions,
} from './pair.js';
export {
  LOCK_TIMEOUT_MS,
  openPairingStore,
  PAIRINGS_FILE,
  STALE_LOCK_MS,
  SYSTEM_NAME_PATTERN,
  type PairingStoreOptions,
  type AgentIdentity,
  type Pairing,
  type PairingPlatform,
  type PairingStore,
} from './pairings.js';
export { AGENT_SENDS_DIR, agentSendHandlers, HEADLESS_TEAM_SECRET_MESSAGE, type AgentSendOptions } from './send.js';
export { AGENT_FIRST_PORT, AGENT_LAST_PORT, AGENT_PORTS } from './ports.js';
export {
  AGENT_CALLER_ID_BASE,
  AGENT_MAX_SOCKETS,
  AGENT_REFRESH_INTERVAL_MS,
  AgentPortsBusyError,
  startAgent,
  type AgentCallContext,
  type AgentHandler,
  type RunningAgent,
  type StartAgentOptions,
} from './server.js';
