import { describe, expect, it } from 'vitest';
import { MAIN_KINDS } from '../src/kinds/kind-main.js';
import { KIND_ROUTES } from '../src/kinds/kind-routes.js';
import { KIND_SENDS } from '../src/kinds/kind-send.js';
import type { ProjectHostCore } from '../src/project-host-core.js';
import { WorkspaceService } from '../src/workspace-service.js';

describe("the kinds' router methods (spec §5.3)", () => {
  it('declares each routed name once across the kinds', () => {
    const names = MAIN_KINDS.flatMap((kind) => Object.keys(kind.routes));
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("names a method of the kind's own host for every route", () => {
    for (const kind of MAIN_KINDS) {
      const host = kind.createHost({} as ProjectHostCore) as unknown as Record<string, unknown>;
      for (const [name, route] of Object.entries(kind.routes)) {
        expect(typeof host[route.method], `${kind.kind}.${name}`).toBe('function');
      }
    }
  });

  it('installs every route on WorkspaceService', () => {
    for (const kind of MAIN_KINDS) {
      for (const name of Object.keys(kind.routes)) {
        expect(typeof (WorkspaceService.prototype as unknown as Record<string, unknown>)[name], name).toBe('function');
      }
    }
  });

  it('looks each kind up to the same route table and send steps MAIN_KINDS carries', () => {
    for (const kind of MAIN_KINDS) {
      expect(KIND_ROUTES[kind.kind], kind.kind).toBe(kind.routes);
      expect(KIND_SENDS[kind.kind], kind.kind).toBe(kind.send);
    }
    expect(Object.keys(KIND_ROUTES)).toEqual(MAIN_KINDS.map((kind) => kind.kind));
  });
});
