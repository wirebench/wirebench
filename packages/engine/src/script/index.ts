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
export { dispatchDeclarations } from './types/dispatch.js';
export type { ApiReferenceSection } from './types/api.js';
export { stripTypes, StripError } from './strip.js';
