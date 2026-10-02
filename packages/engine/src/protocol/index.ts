/** Protocol modules, their registry and the feature set (spec §3, §4). */
export { createFeatureSet } from './features.js';
export type { FeatureDescriptor, FeatureSet, WhyDisabled } from './features.js';
export { defineProtocol } from './module.js';
export type {
  ContainerBase,
  ContainerDir,
  LoadContext,
  ProtocolModule,
  ProtocolRun,
  ProtocolScripting,
  ProtocolStorage,
  RequestSnapshotBase,
  ResponseSnapshotBase,
  RunGroup,
  RunScope,
  ScriptedSend,
  SelectedBase,
  SnapshotFacts,
} from './module.js';
export { createProtocolRegistry, featureDisabled } from './registry.js';
export type { ProtocolRegistry, ProtocolRegistryOptions } from './registry.js';
