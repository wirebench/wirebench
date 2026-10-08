/**
 * What a protocol supplies to run a mock (spec §The protocol facet, ADR-0017). The mock core — files,
 * dispatch, scenarios, the HTTP server — never names a protocol; each protocol's routing, contract
 * check, faults and generation sit behind {@link ProtocolMocking}, an optional facet of its module.
 */

import type { FsLike } from '../project/fs.js';
import type { Project } from '../project/model.js';
import type { HeaderPair } from '../script/model.js';
import type { MockBodyLanguage, MockDef, MockResponse, MockValidation } from './model.js';

/** One request as the mock server received it. Header names keep their case; order is wire order. */
export interface MockRequest {
  /** Upper case. */
  readonly method: string;
  /** The path as received, without the query, percent-encoding kept. */
  readonly path: string;
  /** The query's parameters, each name to every value in order, decoded. */
  readonly query: Readonly<Record<string, readonly string[]>>;
  /** The raw query string, without `?`; empty when there is none. */
  readonly rawQuery: string;
  readonly headers: readonly HeaderPair[];
  readonly body: Buffer;
  /** The body decoded as UTF-8. */
  readonly bodyText: string;
}

/** What a mock replies. */
export interface MockReply {
  readonly status: number;
  readonly headers: readonly HeaderPair[];
  readonly body: string;
}

/** Something about a request that does not conform, or that went wrong while serving it. */
export interface MockProblem {
  readonly code: string;
  readonly message: string;
  /** REST: where the value sits (`path`, `query`, `header`, `cookie`, `body`). */
  readonly in?: string;
  /** REST: the parameter's name. */
  readonly name?: string;
  /** A JSON Pointer–like path into the body, or an element path. */
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

/** What match conditions and a dispatch script read of a routed request. */
export interface MockRequestView {
  readonly bodyKind: 'xml' | 'json' | 'other';
  /** REST path parameters, by name; empty for SOAP. */
  readonly pathParams: Readonly<Record<string, string>>;
}

/** Where the facet sent a request. */
export type MockRoute =
  | {
      readonly kind: 'operation';
      /** The contract operation's key, as `operation.yaml` names it. */
      readonly operation: string;
      /** What the contract check found; under `reject` a route with problems is `refused` instead. */
      readonly problems: readonly MockProblem[];
      readonly view: MockRequestView;
    }
  | {
      /** No operation, a malformed request, or (under `reject`) one that does not conform. */
      readonly kind: 'refused';
      /** The operation, when the request reached one before it was refused. */
      readonly operation?: string;
      readonly problems: readonly MockProblem[];
      readonly reply: MockReply;
    };

/** One operation of the contract a mock implements. */
export interface MockContractOperation {
  readonly key: string;
  /** For display: the SOAP operation name, or REST `POST /orders/{id}`. */
  readonly name: string;
}

/** A contract opened for one running mock. */
export interface MockContract {
  readonly operations: readonly MockContractOperation[];
  /** A definition document the request asks for (`?wsdl`), or undefined to route it. */
  definition(request: MockRequest, mockUrl: string): MockReply | undefined;
  /** Which operation the request calls, checked against the contract as `mode` says. Never rejects. */
  route(request: MockRequest, mode: MockValidation, mockUrl: string): Promise<MockRoute>;
  /** The reply for a failure of the mock itself (no stub, no response, a failed script). */
  fail(code: string, message: string): MockReply;
  /** Headers a stub's reply gets when it does not set them itself (its `Content-Type`). */
  defaults(response: MockResponse): readonly HeaderPair[];
}

/** One generated response, before it has an id. */
export interface GeneratedMockResponse {
  readonly status: number;
  readonly body: MockBodyLanguage;
  readonly bodyText: string;
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
}

/** What a protocol generates for a new mock. */
export interface GeneratedMock {
  /** SOAP: the binding chosen, in Clark notation. */
  readonly binding?: string;
  readonly operations: readonly {
    readonly key: string;
    readonly name: string;
    readonly response: GeneratedMockResponse;
  }[];
}

/**
 * A protocol's mock facet.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ProtocolMocking {
  /**
   * Opens the contract of `mock`'s container from its definition cache, offline.
   *
   * @throws WirebenchError `mock-definition-missing`, `mock-binding-unknown`
   */
  open(input: {
    readonly project: Project;
    readonly root: string;
    readonly fs: FsLike;
    readonly mock: MockDef;
  }): Promise<MockContract>;
  /**
   * The operations and default responses of a new mock for the container.
   *
   * @throws WirebenchError `mock-definition-missing`, `mock-binding-unknown`
   */
  generate(input: {
    readonly project: Project;
    readonly root: string;
    readonly fs: FsLike;
    readonly containerId: string;
    readonly binding?: string;
  }): Promise<GeneratedMock>;
}
