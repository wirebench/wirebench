# @wirebench/engine

`@wirebench/engine` is an internal dependency of [`@wirebench/cli`](https://github.com/wirebench/wirebench/tree/main/packages/cli) and is published so the CLI can depend on a versioned package rather than a workspace link. It has no stability promise of its own: a major release may rename or remove exports, as 3.1 did, and the exports tagged `@internal` may change in any release. See the [Wirebench repository](https://github.com/wirebench/wirebench) for usage, documentation, and issue tracking.

## The plugin API

`@wirebench/engine/plugin` is the exception to "no stability promise": it holds the types a plugin
author builds against (an importer, a reporter, a code generator, the `wirebench-plugin.json`
manifest), imports nothing, and is versioned on its own by `PLUGIN_API_VERSION`. Its surface is the
committed report [`api/plugin.api.md`](api/plugin.api.md); `pnpm check:plugin-api` refuses a change to
it that does not bump the version (minor to add, major to break). How a plugin is installed and what it
may do is [ADR-0031](https://github.com/wirebench/wirebench/blob/main/docs/adr/0031-a-plugin-is-installed-by-the-user-and-runs-with-what-its-manifest-declares.md).

## Packages

The engine is eight workspace packages, and this is the one that publishes. `@wirebench/core` holds the
protocol interface, the registry, the run loop, the project and workspace formats, HTTP, the script
sandbox and everything else the protocols share; `@wirebench/protocol-soap`, `-rest`, `-grpc`, `-ws` and
`-mcp` each hold one protocol, and `@wirebench/protocol-graphql` holds GraphQL, a REST body kind
that REST reaches through a slot this package fills; `@wirebench/engine` composes them
(`protocols.ts`) and exports the API (`index.ts` and the subpaths). The seven others are private: this package reaches them through the
import maps `#core/*` and `#protocol-<name>/*`, which in the workspace name the packages and in the
published tarball name copies under `dist/vendor/<package>/` that `scripts/vendor-packages.mjs` makes at
prepack. Their third-party dependencies are listed here as this package's own. Three rules hold between
them, checked by `pnpm check:engine-layers`: a protocol imports core and itself; core imports core; the
engine imports anything, and nothing imports the engine (ADR-0030).

## Migrating to 6.0

6.0 finishes taking the protocols out of the engine's core ([ADR-0017](https://github.com/wirebench/wirebench/blob/main/docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md), #184 phase 3). Nothing was kept as a deprecated alias.

### Changed

| 5.x                                                            | 6.0                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SendHost.issuedTokens`                                        | `SendHost.protocols.soap.issuedTokens`. Read it with `soapHostOf(host)`, set it with `withSoapHost(host, { issuedTokens })`.                                  |
| `Project.interfaces`                                           | `project.containers.soap`; read it with `soapInterfacesOf(project)`, replace it with `withSoapInterfaces(project, interfaces)`.                               |
| `Project.apis`                                                 | `project.containers.rest`; `restApisOf` / `withRestApis`.                                                                                                     |
| `Project.grpcApis`                                             | `project.containers.grpc`; `grpcApisOf` / `withGrpcApis`.                                                                                                     |
| `Project.wsApis`                                               | `project.containers.websocket`; `wsApisOf` / `withWsApis`.                                                                                                    |
| `Project.extraContainers`, `extraContainersOf`                 | `project.containers[kind]`; `containersOf(project, kind)` / `withContainersOf(project, kind, containers)`. Every kind, built in or not, is in the one map.    |
| `requestFileLocation(project, id)`                             | Takes an optional registry; each module's storage answers through its new `requestLocation(container, id)`.                                                   |
| `Project.webhooks`                                             | `project.protocols.rest`; `webhooksOf(project)` / `withWebhooks(project, collection)`, where `undefined` removes the collection.                              |
| `Project.wss.outgoing`, `Project.wss.incoming`                 | `project.protocols.soap`; `wssConfigsOf(project)` / `withWssConfigs(project, { outgoing, incoming })`.                                                        |
| `Project.wss.keystores`                                        | `Project.keystores`.                                                                                                                                          |
| `HistoryWs.frames`, `HistorySse.rows`, `HistoryEntry.contract` | Typed with History's own `HistoryWsFrame`, `HistorySseRow` and `HistoryContract`, which have the same fields as `WsFrame`, `SseRow` and `RestContractResult`. |

`historyWsOf`, `historySseOf`, `historyContractOf`, `RestEventStreamLike`, `createIssuedTokenSource`, `wssEntrySchema`, `AnyRequestDef` and SOAP's model (`Interface`, `OperationDef`, `SoapRequestDef`, `Endpoint`, `Attachment`, `RequestProperties`, `createInterface`, `createRequest` and the rest) keep their names and signatures; they moved within the package.

`webhooks/` and `wss/outgoing/`, `wss/incoming/` are read and written by REST's and SOAP's new `projectFiles` facet (`ProtocolProjectFiles`), so with REST or SOAP switched off in the registry they are not loaded, and a save leaves them on disk as they are. `protocolDataOf` and `withProtocolData` read and replace any kind's entry in `Project.protocols`. `webhooksFileSchema` and `webhookFolderFileSchema` keep their names and exports; they moved to `webhooks/schema.ts`.

A protocol module's scripting facet (`ProtocolScripting`) has a new required `levelTypes()`: the generated types an API's, interface's or folder's script is checked against, without any one operation's messages (#334). `ScriptedRequest.scripts` is optional and `ScriptedRequest.outer` lists the levels' scripts, outermost first; `SentScripts.levels` lists each script that ran, in order. `scriptLevels`, `activeLevels`, `containerScriptLevels` and `levelScriptTypes` build and read them.

A kind with no containers is absent from `containers`: a loaded project, a new one and one whose last API of a kind was removed through a writer all leave it out. Build a project's containers through the writers, so each container literal is checked against its own type rather than `ContainerBase`.

### Added

MCP is a fifth built-in protocol (`kind: mcp`, #79): an MCP server is a container under `apis/`, beside REST, gRPC and WebSocket APIs, and its requests run one operation each (`tools/list`, `tools/call`, `resources/read`, `prompts/get` and the other lists) over stdio, Streamable HTTP or legacy HTTP+SSE. The model (`McpServer`, `McpRequestDef`, `McpOperation`, `McpTransport`, `McpCatalogue`, `createMcpServer` and the rest), the catalogue file (`serializeMcpCatalogue`, `parseMcpCatalogue`, `mcpCataloguePath`), the send's item (`mcpItemFor`, `McpSelected`, `mcpEffectiveAuth`), its exchange (`McpExchange`, `McpMessage`, `McpLiveEvent`) and its History entry (`buildMcpHistoryEntry`, `historyMcpOf`, `redactMcpExchange`) are exported. `refreshMcpCatalogue(server, scope, host)` lists what a server has on one session, through the same gate as a send, and returns the catalogue as `catalogue.json` stores it; it writes nothing.

A stdio server runs only once its host approves the command line: `SendHost.approveCommand(request)` is asked with a `CommandApprovalRequest` whose `fingerprint` is `commandFingerprint` of the expanded command, arguments, folder and variable names. A host without `approveCommand` refuses every stdio send with `mcp-command-unapproved`.

## Migrating to 3.1

3.1 puts every protocol behind one interface ([ADR-0017](https://github.com/wirebench/wirebench/blob/main/docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md)). The main entry's exports changed; nothing was kept as a deprecated alias. The subpaths (`./xml`, `./rest`, `./json`, `./grpc`, `./asyncapi`, `./snapshot`, `./detect`) did not change.

### Renamed

These names read as every protocol's and were WSDL's and SOAP's. Signatures are unchanged.

| 2.x                     | 3.1                        |
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
// 3.1
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

| 2.x                                                                              | Use instead                                                                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `prepareSend`, `PreparedSend`                                                    | `createRunSender`. A module's own prepare function is internal.                                                                |
| `assertSupportedKind`, `apiKindOf`                                               | `ProtocolRegistry.status(kind)`, which answers `enabled`, `disabled` or `unknown`.                                             |
| `RequestDef`                                                                     | `SoapRequestDef`, which it was an alias of.                                                                                    |
| `scriptTypesFor`                                                                 | The module's `run.scriptTypes`. A run that goes through `createRunSender` or `runRequests` needs neither.                      |
| `RequestScriptTypes.soap`                                                        | `RequestScriptTypes.binding`, an opaque value the module that made it reads back.                                              |
| `ProtocolRun.send`                                                               | `ProtocolRun.open`, which returns an `ExchangeHandle` whose `result` rejects with a send's failure, and `ProtocolRun.resolve`. |
| `RunContext.getSecret`, `proxyFor`, `onSecretValue`, `fetchToken`, `tokenSource` | `RunContext.host`, a `SendHost`: `getSecret`, `proxyFor` (now async), `onSecretValue` and `tokens`.                            |
| `prepareRest`, `prepareSoap`, `prepareGrpc`                                      | `openExchange` and `resolveExchange`. The modules' prepare functions are internal.                                             |
| `ScriptProtocol`                                                                 | `string`.                                                                                                                      |

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
// 3.1
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
// 3.1
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
