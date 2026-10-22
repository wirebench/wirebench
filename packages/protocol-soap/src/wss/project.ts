/**
 * The project's WS-Security outgoing and incoming configurations (spec §3): SOAP's to keep, in
 * `Project.protocols` under `soap`. The keystore registry is not here: REST and gRPC TLS use it too,
 * so it stays core's, as `Project.keystores`.
 */
import type { Project, WssRef } from '#core/project/model';
import { protocolDataOf, withProtocolData } from '#core/project/model';

/** The project's `wss/outgoing/` and `wss/incoming/` configurations, each list sorted by name. */
export interface WssConfigs {
  readonly outgoing: readonly WssRef[];
  readonly incoming: readonly WssRef[];
}

const NONE: WssConfigs = { outgoing: [], incoming: [] };

/** The project's WS-Security configurations; two empty lists when it has none. */
export function wssConfigsOf(project: Project): WssConfigs {
  return (protocolDataOf(project, 'soap') as WssConfigs | undefined) ?? NONE;
}

/**
 * `project` with its WS-Security configurations replaced. Two empty lists are stored as none, as a
 * load leaves them, so two projects holding the same configurations are equal.
 */
export function withWssConfigs(project: Project, configs: WssConfigs): Project {
  const empty = configs.outgoing.length === 0 && configs.incoming.length === 0;
  return withProtocolData(project, 'soap', empty ? undefined : configs);
}
