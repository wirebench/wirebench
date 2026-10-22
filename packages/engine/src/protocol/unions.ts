/**
 * The unions over every composed protocol (package split spec §3.4): the selected request, the sent
 * exchange, the live event, the script snapshots and the saved request of "any built-in protocol".
 *
 * Core declares each as an open interface and never reads a member: its run loop and selector work on
 * `SelectedBase` and store an exchange as a module's `send` returned it. A protocol module adds its
 * member by module augmentation in its `module.ts`, so in a compile that holds every module (every
 * compile of `@wirebench/engine` and of its hosts) the unions are what `protocols.ts` exported before
 * this phase, and a host narrows on `kind` as it always did. In a compile of core alone they are
 * `never`, which nothing in core notices. A host that composes a protocol `@wirebench/engine` does
 * not know imports that protocol's package, or its members are absent from the types (ADR-0030).
 */

/* eslint-disable @typescript-eslint/no-empty-object-type -- each interface is filled by the protocol modules' augmentations */

/** One member per protocol a run can send, keyed by protocol. */
export interface SelectedRequests {}
/** One member per protocol, keyed by protocol: the exchange a request travelled as. */
export interface SentExchanges {}
/** One member per protocol whose exchange streams, keyed by protocol. */
export interface LiveEvents {}
/** One member per protocol that has scripts, keyed by protocol. */
export interface RequestSnapshots {}
/** One member per protocol that has scripts, keyed by protocol. */
export interface ResponseSnapshots {}
/** One member per protocol, keyed by protocol: its saved request. */
export interface RequestDefs {}

/* eslint-enable @typescript-eslint/no-empty-object-type */

/** One saved request selected for a run, of any composed protocol a run can send. */
export type SelectedRequest = SelectedRequests[keyof SelectedRequests];

/** The exchange a request travelled as, for a host that keeps more of it than a report does. */
export type SentExchange = SentExchanges[keyof SentExchanges];

/** A message an open exchange reports, whatever its protocol. */
export type LiveEvent = LiveEvents[keyof LiveEvents];

/** The request snapshot of any composed protocol that has scripts (spec §3.1). */
export type RequestSnapshot = RequestSnapshots[keyof RequestSnapshots];

/** The response snapshot of any composed protocol that has scripts (spec §3.1). */
export type ResponseSnapshot = ResponseSnapshots[keyof ResponseSnapshots];

/**
 * A saved request of any composed protocol, which is what a lookup by request id can return: the id
 * space is one (ULIDs), so `kind` is how a caller finds out what it has.
 */
export type AnyRequestDef = RequestDefs[keyof RequestDefs];
