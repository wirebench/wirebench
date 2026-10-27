import type { FeatureDescriptor } from '@wirebench/engine';
import { grpcKind } from './grpc/kind.js';
import { mcpKind } from './mcp/kind.js';
import { restKind } from './rest/kind.js';
import { soapKind } from './soap/kind.js';
import { wsKind } from './ws/kind.js';

/**
 * The shared half of one protocol kind on the desktop (kind modules spec §4.1): what main and the
 * renderer both need to know of it. The main and renderer halves are looked up by `kind`. This file
 * and every `kinds/<kind>/kind.ts` import no zod and nothing process-specific, so the renderer may
 * value-import them.
 *
 * @internal Composed statically in `KINDS`; not yet a plugin API (ADR-0017).
 */
export interface KindModule<K extends string = string> {
  /** The engine's protocol kind: `soap`, `rest`, `grpc`, `websocket`, `mcp`. */
  readonly kind: K;
  /** The engine module's feature descriptor, repeated here because `@wirebench/wire` imports the engine type-only. */
  readonly feature: FeatureDescriptor;
  /** How the kind is named to a person: `SOAP`, `REST`, `gRPC`, `WebSocket`, `MCP`. */
  readonly label: string;
  /**
   * Its editor tab kinds, as `EditorTab.kind` names them: a request's, a container's, and any other
   * tab of its own (REST's API documentation).
   */
  readonly tabs: { readonly request: string; readonly container: string; readonly extra?: readonly string[] };
  /**
   * A send of this kind is a session the person drives once it opens (WebSocket): its send id is
   * its address for every push and close, so a second open of one still held is refused.
   */
  readonly interactive?: boolean;
}

/** Every desktop kind, in the explorer's tie-break order. */
export const KINDS = [soapKind, restKind, grpcKind, wsKind, mcpKind] as const;

export type KindId = (typeof KINDS)[number]['kind'];

/** @throws Error for a kind the desktop has no half of */
export function kindById(kind: KindId): KindModule<KindId> {
  const found = KINDS.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`unknown kind: ${String(kind)}`);
  return found;
}

/** Whether sends of `kind` are sessions a person drives once open; false for a kind the desktop has no half of. */
export function isInteractive(kind: string): boolean {
  const found: KindModule | undefined = KINDS.find((candidate) => candidate.kind === kind);
  return found?.interactive === true;
}

/** Narrows a kind from outside (the wire, a project file) to a desktop kind; undefined for any other. */
export function toKindId(kind: string): KindId | undefined {
  return KINDS.find((candidate) => candidate.kind === kind)?.kind;
}
