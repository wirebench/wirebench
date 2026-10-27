import { AsyncLocalStorage } from 'node:async_hooks';
import { WirebenchError } from '@wirebench/engine';
import type { KindRouters } from './kinds/kind-main.js';
import { KIND_ROUTES } from './kinds/kind-routes.js';
import type { ProjectRouter } from './project-router.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * The `Caller.id` of the window whose IPC call is running, for the handler and everything it
 * starts (its awaits, timers and the sends it puts through the engine). The transport (`bindIpc`) sets it.
 */
const caller = new AsyncLocalStorage<number>();

/** Runs `fn` as a call from the window whose `Caller.id` is `id`. */
export function runAsCaller<T>(id: number, fn: () => T): T {
  return caller.run(id, fn);
}

/** The calling window's `Caller.id`, or `undefined` outside an IPC call (a timer, launch, quit). */
export function callerId(): number | undefined {
  return caller.getStore();
}

/**
 * Every open window's per-window objects (multi-window design D1), keyed by `Caller.id`. What a
 * channel reaches through {@link routeWorkspaces} and {@link scoped} is picked from here.
 */
export class WindowScopes<S> {
  private readonly scopes = new Map<number, S>();

  add(id: number, scope: S): void {
    this.scopes.set(id, scope);
  }

  remove(id: number): void {
    this.scopes.delete(id);
  }

  get(id: number): S | undefined {
    return this.scopes.get(id);
  }

  all(): readonly S[] {
    return [...this.scopes.values()];
  }

  /**
   * The calling window's scope. With no caller, the only window's, so a single window behaves as
   * before; `undefined` with several (or none), and when the caller's window has already closed.
   */
  callerOrOnly(): S | undefined {
    const id = callerId();
    if (id !== undefined) {
      return this.scopes.get(id);
    }
    return this.scopes.size === 1 ? this.all()[0] : undefined;
  }

  /**
   * {@link callerOrOnly}, or a refusal rather than a guess.
   *
   * @throws WirebenchError `no-window` when no window can be named
   */
  current(): S {
    const scope = this.callerOrOnly();
    if (scope === undefined) {
      throw new WirebenchError('no-window', 'There is no window to do this in.');
    }
    return scope;
  }

  /** The first scope `test` accepts, the caller's own looked at first. */
  find(test: (scope: S) => boolean): S | undefined {
    const own = this.callerOrOnly();
    if (own !== undefined && test(own)) {
      return own;
    }
    return this.all().find((scope) => scope !== own && test(scope));
  }
}

/**
 * The core's `ProjectRouter` methods, each taking the entity (or project) id it acts on first. Typed so
 * a core method added to the router without being added here fails to compile; each kind's come from
 * its route table.
 */
const CORE_ROUTER_METHODS = {
  projectSnapshot: true,
  projectMutate: true,
  save: true,
  proxyFor: true,
  trustAnchorsFor: true,
  clientIdentityFor: true,
  keystoreFor: true,
  writeImportedScripts: true,
  importProperties: true,
  reload: true,
  projectId: true,
  scopesFor: true,
  preflight: true,
  tlsFor: true,
  sendEnvironments: true,
  runContextFor: true,
  apiDefinitionDocuments: true,
  apiDefinitionText: true,
  exportApiDefinitionTo: true,
  inspectKeystore: true,
} satisfies Record<Exclude<keyof ProjectRouter, keyof KindRouters>, true>;

/** Entity-addressed `WorkspaceService` methods: every router method, the core's and each kind's, plus the host lookups main itself uses. */
const ENTITY_ROUTED: ReadonlySet<string> = new Set<string>([
  ...Object.keys(CORE_ROUTER_METHODS),
  ...Object.values(KIND_ROUTES).flatMap((routes) => Object.keys(routes)),
  'hostFor',
  'hostOfEntity',
]);

/**
 * One object standing in for every window's `WorkspaceService` (design D2). An entity-addressed call
 * goes to the window whose workspace holds the id, the caller's first, so a script worker or a token
 * fetch finds its project from any context; an id no window holds goes to the caller's window, whose
 * service refuses it as before (`projectId` answers `undefined`). Every other call is the caller's
 * window's, and refused with `no-window` when there are several and no caller.
 */
export function routeWorkspaces<S>(scopes: WindowScopes<S>, of: (scope: S) => WorkspaceService): WorkspaceService {
  return new Proxy({} as WorkspaceService, {
    get(_target, prop) {
      // Never a thenable, and nothing for an inspector to trip over.
      if (typeof prop !== 'string' || prop === 'then') {
        return undefined;
      }
      if (ENTITY_ROUTED.has(prop)) {
        return (...args: unknown[]): unknown => {
          const [id] = args;
          const owner =
            typeof id === 'string' ? scopes.find((scope) => of(scope).projectId(id) !== undefined) : undefined;
          if (owner === undefined && prop === 'projectId') {
            return undefined;
          }
          const service = of(owner ?? scopes.callerOrOnly() ?? scopes.all()[0] ?? scopes.current());
          return (Reflect.get(service, prop, service) as (...rest: unknown[]) => unknown).apply(service, args);
        };
      }
      return member(of(scopes.current()), prop);
    },
  });
}

/** The calling window's own `T` (its picks, cookie jar, current values, …), as one object. */
export function scoped<S, T extends object>(scopes: WindowScopes<S>, of: (scope: S) => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') {
        return undefined;
      }
      return member(of(scopes.current()), prop);
    },
  });
}

/** `target[prop]`, bound to `target` when it is a method. */
function member(target: object, prop: string): unknown {
  const value: unknown = Reflect.get(target, prop, target);
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}
