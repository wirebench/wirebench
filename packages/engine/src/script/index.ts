/** Typed scripting (#63): the sandbox, the checker, the API's types and a request's scripts in a send. */
export { createScriptSandbox, clampTimeout, SCRIPT_QUEUE_LIMIT } from './sandbox/host.js';
export type { ScriptSandbox, ScriptSandboxOptions } from './sandbox/host.js';
export { SCRIPT_LIMITS } from './sandbox/model.js';
export type { SandboxLog, ScriptPosition } from './sandbox/model.js';
export { createScriptChecker, CHECK_DEADLINE_MS, ScriptCheckerError } from './check/host.js';
export type {
  ScriptChecker,
  ScriptCheckerOptions,
  ScriptCompletion,
  ScriptDiagnostic,
  ScriptModel,
  ScriptQuickInfo,
  ScriptSignatureHelp,
} from './check/host.js';
export { isScriptFileOf, SCRIPT_OUTPUT_LIMITS, scriptFileName } from './model.js';
export type {
  HeaderPair,
  RequestScripts,
  ScriptApi,
  ScriptErrorCode,
  ScriptFailure,
  ScriptLog,
  ScriptOutcome,
  ScriptPhase,
  ScriptProtocol,
  ScriptSource,
  ScriptTest,
  ScriptValue,
} from './model.js';
export {
  activeScripts,
  assertScriptsUsable,
  RequestScripting,
  scriptError,
  typeCheckError,
} from './request-scripts.js';
export type {
  RequestScriptingOptions,
  RequestScriptTypes,
  ScriptedRequest,
  ScriptRunValues,
} from './request-scripts.js';
export { SecretPlaceholders } from './send.js';
export { scriptProperties } from './props.js';
export { apiDeclarations, apiReference, scriptDeclarations, secretNameType } from './types/api.js';
export type { ApiReferenceSection } from './types/api.js';
export { stripTypes, StripError } from './strip.js';

// What lives in the protocol folders since the scripting facet, under the names it always had.
// These lines are the only place `script/` names a protocol; slice 5 moves them to `index.ts`.
export type { RequestSnapshot, ResponseSnapshot } from '../protocols.js';
export { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from '../rest/scripting.js';
export type { RestRequestSnapshot, RestResponseSnapshot } from '../rest/scripting.js';
export { loadOpenApiDocument, restOperationFor, restScriptTypes } from '../rest/script-types.js';
export { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from '../soap/scripting.js';
export type { SoapRequestSnapshot, SoapResponseSnapshot } from '../soap/scripting.js';
export {
  projectSoapBody,
  qnameFromClark,
  replaceSoapBody,
  soapOperationElements,
  soapScriptTypes,
} from '../soap/script-types.js';
export { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from '../grpc/scripting.js';
export type { GrpcRequestSnapshot, GrpcResponseSnapshot } from '../grpc/scripting.js';
export { grpcMessageTypes, grpcScriptTypes } from '../grpc/script-types.js';
