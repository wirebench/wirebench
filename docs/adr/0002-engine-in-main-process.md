# ADR-0002: The engine runs in the main process, behind an `EngineService` interface

- Status: accepted
- Date: 2026-09-09
- Context: spec §4 (architecture), §16 open question 6, §17 (decision log)

## Context

`@wirebench/engine` does the heavy work: parsing multi-megabyte WSDL/XSD bundles, building
schema sets, generating envelopes, XML-DSig/XML-Enc, XPath and XQuery evaluation, HTTP sends.
Some of that is CPU-bound and can block whatever thread it runs on for hundreds of
milliseconds. Electron offers three places to put it: the renderer (impossible — the renderer
is sandboxed and has no Node), the main process, or a separate `utilityProcess`.

A `utilityProcess` isolates the work and keeps the main process responsive; it also means
every engine call crosses a serialization boundary, every model object has to be structured
-cloneable, cancellation becomes a protocol rather than an `AbortSignal`, and crash recovery
becomes a feature.

## Decision

The engine runs **in the main process in v1**, reached only through an `EngineService`
interface that the IPC handlers call. No renderer code imports the engine; no engine code
knows that Electron exists.

The interface is the point: every entry point is `async` and takes an `AbortSignal`, and no
caller depends on the engine being in-process. Moving it into a `utilityProcess` later is an
implementation change behind that interface, not a redesign of the app.

## Rationale

- **The renderer stays sandboxed either way.** The security win people reach for a separate
  process to get is already delivered by `sandbox: true` + `contextIsolation: true` + typed
  IPC (ADR-0005); a utility process would only isolate main from main's own work.
- **`AbortSignal` survives.** In-process, cancelling an import or a send is a signal on a
  live object. Across a process boundary it is a message, a correlation id, and a race.
- **Rich model objects stay rich.** The parsed `WsdlDefinition`/`SchemaSet` graph has shared
  references and is queried repeatedly; structured-cloning it per call would dominate the
  cost of using it.
- **Measure before paying.** The performance budgets (spec §11,
  `packages/engine/test/perf/budgets.test.ts`, `e2e/specs/perf.spec.ts`) are the trigger: if
  a real workload makes the UI stutter, the move is already designed for.

## Consequences

- A pathological document can make the main process unresponsive. The budgets exist to catch
  that class of regression; XPath evaluation additionally runs under a timeout
  (`evaluateWithTimeout`).
- An engine crash takes the app with it. Accepted for v1: the engine is pure computation over
  data the user supplied, and it throws typed `WirebenchError`s rather than aborting.
- The `EngineService` boundary must not leak. Any API that only works because both sides share
  a heap — passing a callback, handing out a mutable object — would quietly make the
  utility-process move impossible; the interface is stated in terms of data and signals only.
