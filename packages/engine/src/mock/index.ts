/** Mock services: contract-validated stubs kept as files under `mocks/` (#59, ADR-0021). */
export * from './model.js';
export {
  DISPATCH_SCRIPT_FILE,
  MOCKS_DIR,
  MOCK_FILE,
  MOCK_OPERATIONS_DIR,
  MOCK_RESERVED_HEADERS,
  OPERATION_FILE,
  RESPONSE_SUFFIX,
  bodyFilePath,
  mockDirPath,
  mockDocument,
  mockFilePath,
  mockFileSchema,
  mockFiles,
  operationDirPath,
  operationDocument,
  operationFileSchema,
  parseMockFile,
  parseOperationFile,
  parseResponseFile,
  responseDocument,
  responseFilePath,
  responseFileSchema,
  responseSlugOf,
} from './file.js';
export type { MockOperationSettings, MockResponseSettings, MockSettings } from './file.js';
export { readMocks } from './load.js';
export type { LoadedMock, MockFileProblem, MockFiles } from './load.js';
export type {
  GeneratedMock,
  GeneratedMockResponse,
  MockContract,
  MockContractOperation,
  MockProblem,
  MockReply,
  MockRequest,
  MockRequestView,
  MockRoute,
  ProtocolMocking,
} from './contract.js';
export { MockState, candidates, dispatch } from './dispatch.js';
export type { DispatchDeps, DispatchResult, DispatchScriptRunner, ScriptDecision } from './dispatch.js';
export { DISPATCH_SCRIPT_BODY_BYTES, createDispatchScriptRunner } from './script.js';
export {
  MOCK_EVENT_BODY_BYTES,
  MOCK_REQUEST_BODY_BYTES,
  MOCK_REQUEST_TIMEOUT_MS,
  openMockContract,
  startMock,
} from './server.js';
export type { MockEventMessage, MockExchangeEvent, MockWarning, RunningMock, StartMockInput } from './server.js';
export { generateMock, mockFacetFor } from './generate.js';
export type { GenerateMockOptions } from './generate.js';
export { addRecordedStubs } from './record-stubs.js';
export { RECORD_RELAY_BYTES, RECORD_UPSTREAM_TIMEOUT_MS, startRecorder } from './record.js';
export type { RecordExchangeEvent, RunningRecorder, StartRecorderInput } from './record.js';
export type { AddRecordedStubsOptions, MockRecording, RecordedStubSkip, RecordedStubs } from './record-stubs.js';
