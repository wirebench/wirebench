/**
 * SOAP's router methods (spec §5.3): each names the SOAP host method it reaches and how the
 * host is found. `ProjectRouter`, `WorkspaceService` and `window-scope.ts` all derive from this
 * one list, so a method is declared here once.
 */

import type { ProjectWire } from '@wirebench/wire/wire-types';
import type { KindRoute, KindRouter } from '../kind-main.js';
import type { SoapHost } from './host.js';

export const soapRoutes = {
  /**
   * Imports a definition into the addressed project. `project.addInterface` carries a target of
   * `{ projectId }` (or `{ newProjectName }`, which a later task resolves to a project first).
   */
  addInterface: { method: 'addInterface', by: 'project' },
  /** Imports a parsed legacy SOAP project into the addressed project. */
  importLegacyProject: { method: 'importLegacyProject', by: 'project' },
  requestMeta: { method: 'requestMeta', by: 'entity' },
  requestSource: { method: 'requestSource', by: 'entity' },
  sendAttachmentsFor: { method: 'sendAttachmentsFor', by: 'entity' },
  /** The endpoint a SOAP request is sent to under an environment; none when nothing resolves one. */
  endpointFor: { method: 'endpointFor', by: 'entity' },
  dumpFileFor: { method: 'dumpFileFor', by: 'entity' },
  /** The credentials configured on one SOAP interface, endpoint or request — its own, not its effective ones. */
  soapAuthOf: { method: 'soapAuthOf', by: 'entity' },
  /** The WSDL-derived default `wsa:Action` of a SOAP request's operation, from the loaded definition. */
  defaultWsaActionFor: { method: 'defaultWsaActionFor', by: 'entity' },
  hasOutgoingWss: { method: 'hasOutgoingWss', by: 'entity' },
  wssPolicyInputs: { method: 'wssPolicyInputs', by: 'entity' },
  validationTargetFor: { method: 'validationTargetFor', by: 'entity' },
  insertWsaHeaders: { method: 'insertWsaHeaders', by: 'entity' },
  removeWsaHeadersFrom: { method: 'removeWsaHeadersFrom', by: 'entity' },
  previewOutgoingWss: { method: 'previewOutgoingWss', by: 'entity' },
  /** Routed by its first argument, the project id (the entry it names is not an entity of its own). */
  issuedTokenTarget: { method: 'issuedTokenTarget', by: 'project-kept' },
  insertWssEntry: { method: 'insertWssEntry', by: 'entity' },
  removeOutgoingWssFrom: { method: 'removeOutgoingWssFrom', by: 'entity' },
  resolveAttachmentPath: { method: 'resolveAttachmentPath', by: 'entity' },
  addAttachmentBytes: { method: 'addAttachmentBytes', by: 'entity' },
  planDefinitionUpdate: { method: 'planDefinitionUpdate', by: 'entity' },
  applyDefinitionUpdate: { method: 'applyDefinitionUpdate', by: 'entity' },
  exportDefinitionTo: { method: 'exportDefinitionTo', by: 'entity' },
  definitionDocs: { method: 'definitionDocs', by: 'entity' },
} as const satisfies Readonly<Record<string, KindRoute<SoapHost>>>;

export type SoapRouter = KindRouter<SoapHost, typeof soapRoutes>;

/**
 * The ids SOAP's channels address, for `WorkspaceService`'s routing index: interfaces, their
 * endpoints (an endpoint can own an OAuth2 configuration, so `oauth2.*` channels address it) and
 * requests.
 */
export function* soapEntityIds(project: ProjectWire): Iterable<string> {
  for (const iface of project.interfaces) {
    yield iface.id;
    for (const endpoint of iface.endpoints) yield endpoint.id;
  }
  for (const request of project.requests) yield request.id;
}
