/**
 * The browser-safe face of `ws/`: pure helpers with no Node dependency, reachable from the
 * renderer as `@wirebench/engine/ws` (ESLint allows this subpath and no other). `model.ts` needs
 * `project/paths.js` for its slugs (`node:path`), so only its types are re-exported here — the
 * factories (`createWsApi` and friends) stay engine-side; the tree-walking and file-naming rules
 * come from `shape.ts`, which is node-free, and URL resolution and frame pretty-printing come from
 * `url.ts` and `pretty.ts`, also node-free.
 */

export type {
  CreateWsApiInput,
  CreateWsFolderInput,
  CreateWsRequestInput,
  WsApi,
  WsDefinitionRef,
  WsExchange,
  WsFolder,
  WsFrame,
  WsHandshake,
  WsOpcode,
  WsRequestDef,
  WsRequestSettings,
  WsSavedMessage,
} from './model.js';
export { wsApiFolders, wsApiRequests, wsFolderRequests, wsMessageFileName } from './shape.js';
export { resolveWsUrl } from './url.js';
export { prettyFrameText } from './pretty.js';
export type { PrettyFrameResult } from './pretty.js';
