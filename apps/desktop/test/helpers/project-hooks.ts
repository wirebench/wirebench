import type { ProjectHostHooks } from '../../src/main/project-host.js';
import { createHostState } from '../../src/main/host/host-state.js';

/** Hooks for a test-built `ProjectHost`: its own host state (a real host passes the host's) plus `extra`. */
export function testHooks(extra: Omit<ProjectHostHooks, 'hostState'> = {}): ProjectHostHooks {
  return { hostState: createHostState(), ...extra };
}
