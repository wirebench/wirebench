# @wirebench/engine

`@wirebench/engine` is an internal dependency of [`@wirebench/cli`](https://github.com/wirebench/wirebench/tree/main/packages/cli) and is published so the CLI can depend on a versioned package rather than a workspace link. It has no stability promise of its own: a major release may rename or remove exports, as 3.0 did, and the exports tagged `@internal` may change in any release. See the [Wirebench repository](https://github.com/wirebench/wirebench) for usage, documentation, and issue tracking.

## Migrating to 3.0

3.0 puts every protocol behind one interface ([ADR-0017](https://github.com/wirebench/wirebench/blob/main/docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md)). The main entry's exports changed; nothing was kept as a deprecated alias. The subpaths (`./xml`, `./rest`, `./json`, `./grpc`, `./asyncapi`, `./snapshot`, `./detect`) did not change.

### Renamed

These names read as every protocol's and were WSDL's and SOAP's. Signatures are unchanged.

| 2.x                     | 3.0                        |
| ----------------------- | -------------------------- |
| `importDefinition`      | `importWsdl`               |
| `ImportSource`          | `WsdlImportSource`         |
| `ImportOptions`         | `WsdlImportOptions`        |
| `ImportCacheOptions`    | `WsdlImportCacheOptions`   |
| `ImportProgress`        | `WsdlImportProgress`       |
| `ImportProblem`         | `WsdlImportProblem`        |
| `ImportResult`          | `WsdlImportResult`         |
| `summarizeOperations`   | `summarizeSoapOperations`  |
| `OperationSummary`      | `SoapOperationSummary`     |
| `generateRequest`       | `generateSoapRequest`      |
| `generateEmptyRequest`  | `generateEmptySoapRequest` |
| `toSendInput`           | `toSoapSendInput`          |
| `ToSendInputArgs`       | `ToSoapSendInputArgs`      |
| `SendRequestInput`      | `SoapSendRequestInput`     |
| `SendAttachmentOptions` | `SoapAttachmentOptions`    |

```ts
// 2.x
import { generateRequest, importDefinition } from '@wirebench/engine';
import type { ImportResult } from '@wirebench/engine';

const result: ImportResult = await importDefinition({ kind: 'file', path: 'calculator.wsdl' });
const [operation] = result.operations;
if (operation !== undefined) {
  const sample = generateRequest(result, {
    bindingName: operation.bindingName,
    operationName: operation.operationName,
  });
}
```

```ts
// 3.0
import { generateSoapRequest, importWsdl } from '@wirebench/engine';
import type { WsdlImportResult } from '@wirebench/engine';

const result: WsdlImportResult = await importWsdl({ kind: 'file', path: 'calculator.wsdl' });
const [operation] = result.operations;
if (operation !== undefined) {
  const sample = generateSoapRequest(result, {
    bindingName: operation.bindingName,
    operationName: operation.operationName,
  });
}
```

### Removed

| 2.x                                                                              | Use instead                                                                                               |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `prepareSend`, `PreparedSend`                                                    | `createRunSender`. A module's own prepare function is internal.                                           |
| `assertSupportedKind`, `apiKindOf`                                               | `ProtocolRegistry.status(kind)`, which answers `enabled`, `disabled` or `unknown`.                        |
| `RequestDef`                                                                     | `SoapRequestDef`, which it was an alias of.                                                               |
| `scriptTypesFor`                                                                 | The module's `run.scriptTypes`. A run that goes through `createRunSender` or `runRequests` needs neither. |
| `RequestScriptTypes.soap`                                                        | `RequestScriptTypes.binding`, an opaque value the module that made it reads back.                         |
| `ProtocolRun.send`                                                               | `ProtocolRun.open`, which returns an `ExchangeHandle` and never throws, and `ProtocolRun.resolve`.        |
| `RunContext.getSecret`, `proxyFor`, `onSecretValue`, `fetchToken`, `tokenSource` | `RunContext.host`, a `SendHost`: `getSecret`, `proxyFor` (now async), `onSecretValue` and `tokens`.       |
| `prepareRest`, `prepareSoap`, `prepareGrpc`                                      | `openExchange` and `resolveExchange`. The modules' prepare functions are internal.                        |
| `ScriptProtocol`                                                                 | `string`.                                                                                                 |

`prepareSend` handed back one of three shapes, and the caller sent it with the matching function. `createRunSender` does both, with the run's caches and the request's scripts:

```ts
// 2.x
import { prepareSend, selectRequests, sendRest } from '@wirebench/engine';

const { selected } = selectRequests(project, ['Orders/List orders']);
for (const item of selected) {
  const prepared = await prepareSend(item, context);
  if (prepared.kind === 'rest') {
    const exchange = await sendRest(prepared.input);
    console.log(item.path, exchange.status);
  }
}
```

```ts
// 3.0
import { createRunSender, selectRequests } from '@wirebench/engine';

const { selected } = selectRequests(project, ['Orders/List orders']);
const send = createRunSender(context);
for (const item of selected) {
  const sent = await send(item);
  console.log(item.path, sent.subject.status);
}
```

`sent.exchange` holds the whole SOAP or REST exchange when a host needs more than the status, and `sendSoapRequest`, `sendRest` and `callGrpc` are still exported for a caller that builds its own input.

`ProtocolRun.send` returned the finished exchange. `open` starts the send and returns a handle: its `events` are the live events (read only when `ExchangeOptions.live` is true), `push`, `halfClose` and `close` drive a stream, `cancel` ends this send only, and `result` settles with what `send` returned or rejects with its error. `interactive` is true when the host drives the messages itself; otherwise the request's saved messages are sent. A push, half-close or close on a send that takes no messages is refused with `exchange-not-streaming`. `resolve` is the first step alone, with nothing connected.

```ts
// 2.x
const context = { project, projectDir, overrides: {}, getSecret, proxyFor, tokenSource };
const sent = await module.run.send(item, scope);
```

```ts
// 3.0
import { openExchange } from '@wirebench/engine';

const context = { project, projectDir, overrides: {}, host: { getSecret, proxyFor, tokens } };
const handle = openExchange(item, context.host, {
  scope: createRunScope(context),
  interactive: false,
  run: true,
});
const sent = await handle.result;
```

`SendHost` carries what a host lends a send. Only `getSecret` is required; where a member is absent the send behaves as the command line's does. A run (`ExchangeOptions.run`) waits for a stream's answer within the run's timeout and fails a stream the timeout cuts with `timeout`.

### Widened

`RequestResult.protocol`, `AssertionSubject.protocol` and `ScriptedRequest.protocol` were the union `'soap' | 'rest' | 'grpc'` and are now `string`. Code that copies one of them into a closed union needs a check first; a comparison such as `result.protocol === 'grpc'` compiles as before.

### Added

`openExchange`, `resolveExchange`, `SendHost`, `SendFailure`, `ClientIdentity`, `AttemptedRequest`, `ExchangeHandle`, `ExchangeOptions`, `ExchangeController`, `exchangeController`, `notStreaming`, `PushMessage`, `StreamingSide`, `LiveEventBase`, `EventQueue` and `createRunScope`, for the send path above, and `ProtocolModule` and its facets (`ProtocolStorage`, `ProtocolRun`, `ProtocolScripting`), `defineProtocol`, `ProtocolRegistry`, `createProtocolRegistry`, `createBuiltinRegistry`, `BUILTIN_PROTOCOLS`, `FeatureDescriptor`, `FeatureSet`, `createFeatureSet`, `UnsupportedContainer`, `unsupportedOf`, `extraContainersOf`, `takenContainerSlugs`, `grpcStatusNames`, `StatusNames`, `SnapshotFacts`, `SelectedBase`, `RunGroup`, `RunScope`, `ScriptedSend`, `ContainerBase`, `ContainerDir`, `LoadContext`, `RequestSnapshotBase`, `ResponseSnapshotBase`, `ProtocolRegistryOptions`, `WhyDisabled`, `Project.unsupported`, `Project.extraContainers` and `AssertionSubject.statusNames`. They are exported for Wirebench's own hosts and tagged `@internal`: they are not a plugin API, and they may change in any release. `RunContext` also gains an optional `registry`; it is not tagged, as `RunContext` stays part of the run API.

A project can now hold containers the engine did not load: one whose `kind` has no module in the build, or whose protocol is switched off. `loadProject` reports each as a `container-unsupported` problem and lists it in `Project.unsupported`; `saveProject` leaves its files untouched. A host that lists a project's containers should list these too, as not loaded.
