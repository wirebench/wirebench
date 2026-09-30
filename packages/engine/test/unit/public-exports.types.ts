// packages/engine/test/unit/public-exports.types.ts
/**
 * The type half of the public-exports guard (spec §8). Nothing runs this file: `tsc -b` checks it
 * through `packages/engine/tsconfig.test.json`. A 3.0 type that goes missing is an error where it
 * is named; a 2.x type that comes back makes its `@ts-expect-error` unused, which is an error too.
 */
import type * as Engine from '../../src/index.js';

/** Every type 3.0 adds. */
export type Added = [
  Engine.ProtocolModule,
  Engine.ProtocolStorage,
  Engine.ProtocolRun,
  Engine.ProtocolScripting,
  Engine.SnapshotFacts,
  Engine.SelectedBase,
  Engine.RunGroup,
  Engine.RunScope,
  Engine.ScriptedSend,
  Engine.ContainerBase,
  Engine.ContainerDir,
  Engine.LoadContext,
  Engine.RequestSnapshotBase,
  Engine.ResponseSnapshotBase,
  Engine.ProtocolRegistry,
  Engine.ProtocolRegistryOptions,
  Engine.FeatureDescriptor,
  Engine.FeatureSet,
  Engine.WhyDisabled,
  Engine.UnsupportedContainer,
];

/** Every type 3.0 renames, under its new name. */
export type Renamed = [
  Engine.WsdlImportSource,
  Engine.WsdlImportOptions,
  Engine.WsdlImportCacheOptions,
  Engine.WsdlImportProgress,
  Engine.WsdlImportProblem,
  Engine.WsdlImportResult,
  Engine.SoapOperationSummary,
  Engine.ToSoapSendInputArgs,
  Engine.SoapSendRequestInput,
  Engine.SoapAttachmentOptions,
];

/** A sample of the types spec §8 lists as unchanged, and every type Task 5.2, Step 9 moved to a direct export. */
export type Unchanged = [
  Engine.SendAuth,
  Engine.AuthSummary,
  Engine.SelectedRequest,
  Engine.SentExchange,
  Engine.SentRequest,
  Engine.RunContext,
  Engine.SoapRequestDef,
  Engine.AttachmentResolvers,
  Engine.RequestSnapshot,
  Engine.ResponseSnapshot,
  Engine.SoapRequestSnapshot,
  Engine.SoapResponseSnapshot,
  Engine.RestRequestSnapshot,
  Engine.RestResponseSnapshot,
  Engine.GrpcRequestSnapshot,
  Engine.GrpcResponseSnapshot,
  Engine.InterfaceFile,
  Engine.RequestFile,
  Engine.ApiFile,
  Engine.RestRequestFile,
  Engine.GrpcApiFile,
  Engine.GrpcRequestFile,
];

/** The fields 3.0 adds exist. */
export type AddedFields = [
  Engine.Project['unsupported'],
  Engine.Project['extraContainers'],
  Engine.AssertionSubject['statusNames'],
  Engine.RequestScriptTypes['binding'],
  Engine.RunContext['registry'],
];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

/** The three `protocol` fields are `string`, not a closed union. */
export type Widened = [
  Expect<Same<Engine.RequestResult['protocol'], string>>,
  Expect<Same<Engine.AssertionSubject['protocol'], string>>,
  Expect<Same<Engine.ScriptedRequest['protocol'], string>>,
];

// @ts-expect-error -- renamed to `WsdlImportSource` in 3.0
export type Gone01 = Engine.ImportSource;
// @ts-expect-error -- renamed to `WsdlImportOptions` in 3.0
export type Gone02 = Engine.ImportOptions;
// @ts-expect-error -- renamed to `WsdlImportCacheOptions` in 3.0
export type Gone03 = Engine.ImportCacheOptions;
// @ts-expect-error -- renamed to `WsdlImportProgress` in 3.0
export type Gone04 = Engine.ImportProgress;
// @ts-expect-error -- renamed to `WsdlImportProblem` in 3.0
export type Gone05 = Engine.ImportProblem;
// @ts-expect-error -- renamed to `WsdlImportResult` in 3.0
export type Gone06 = Engine.ImportResult;
// @ts-expect-error -- renamed to `SoapOperationSummary` in 3.0
export type Gone07 = Engine.OperationSummary;
// @ts-expect-error -- renamed to `ToSoapSendInputArgs` in 3.0
export type Gone08 = Engine.ToSendInputArgs;
// @ts-expect-error -- renamed to `SoapSendRequestInput` in 3.0
export type Gone09 = Engine.SendRequestInput;
// @ts-expect-error -- renamed to `SoapAttachmentOptions` in 3.0
export type Gone10 = Engine.SendAttachmentOptions;
// @ts-expect-error -- removed in 3.0: a module's own prepare function is internal
export type Gone11 = Engine.PreparedSend;
// @ts-expect-error -- removed in 3.0: use `SoapRequestDef`
export type Gone12 = Engine.RequestDef;
// @ts-expect-error -- removed in 3.0: a protocol is a `string`
export type Gone13 = Engine.ScriptProtocol;
// @ts-expect-error -- `RequestScriptTypes.soap` became `binding` in 3.0
export type Gone14 = Engine.RequestScriptTypes['soap'];
