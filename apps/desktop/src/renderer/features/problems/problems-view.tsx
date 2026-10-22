import { AlertTriangle, XCircle } from 'lucide-react';
import { explorerActions } from '../explorer/explorer-actions.js';
import { revealProblem } from '../request-editor/validate-actions.js';
import { revealContractProblem } from '../rest-editor/response/contract.js';
import { revealLintFinding } from '../rest-api/lint-actions.js';
import { lintLocationLabel } from './lint-location.js';
import type { Problem, ProblemsFilter } from '../../state/problems.js';
import { filterProblems, isLintProblem, useProblemsStore } from '../../state/problems.js';
import { useProjectStore } from '../../state/project.js';
import { useGridNavigation } from '../../lib/grid-navigation.js';

const SOURCE_CLASS = 'shrink-0 rounded-sm border border-hairline px-1 font-mono text-xs text-fg-subtle';

/**
 * The chips: every problem, one severity, or the lint findings on their own (#745). Lint is a
 * separate list rather than a severity, so All, Errors and Warnings never count a style finding.
 */
const FILTERS: readonly { id: ProblemsFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'lint', label: 'Lint' },
];

/** The count a chip shows after its label, or none when there is nothing to count. */
function chipCount(id: ProblemsFilter, items: readonly Problem[]): string {
  const count =
    id === 'all'
      ? 0
      : id === 'lint'
        ? items.filter(isLintProblem).length
        : items.filter((item) => !isLintProblem(item) && item.severity === id).length;
  return count > 0 ? ` (${String(count)})` : '';
}

function key(item: Problem, index: number): string {
  return `${item.groupId}:${String(index)}`;
}

/**
 * `<project> › <interface>`, or just `<interface>`, or nothing — whichever segments the store
 * can resolve. A request-scoped problem resolves its project/interface through the request;
 * an import problem's `groupId` is the interface id itself, so it resolves directly; a lint
 * problem's group names the REST API it was found in.
 */
function breadcrumbOf(
  item: Problem,
  requests: Readonly<Record<string, { readonly interfaceId: string; readonly name: string }>>,
  interfaces: Readonly<Record<string, { readonly name: string }>>,
  apis: Readonly<Record<string, { readonly name: string }>>,
  projects: Readonly<Record<string, { readonly name: string }>>,
  projectOf: Readonly<Record<string, string>>,
): string | undefined {
  const apiId = item.source === 'lint' ? item.groupId.slice('lint:'.length) : undefined;
  const interfaceId = item.requestId === undefined ? item.groupId : requests[item.requestId]?.interfaceId;
  const containerName =
    apiId !== undefined ? apis[apiId]?.name : interfaceId === undefined ? undefined : interfaces[interfaceId]?.name;
  const owner = apiId ?? item.requestId ?? item.groupId;
  const projectId = projectOf[owner];
  const projectName = projectId === undefined ? undefined : projects[projectId]?.name;
  const segments = [projectName, containerName].filter((segment): segment is string => segment !== undefined);
  return segments.length === 0 ? undefined : segments.join(' › ');
}

/** `line:col`, or just `line`, or nothing at all — whatever the problem actually knows. */
function locationLabel(problem: Problem['problem']): string | undefined {
  if (problem.line === undefined) {
    return problem.location;
  }
  const position = problem.column === undefined ? String(problem.line) : `${problem.line}:${problem.column}`;
  return problem.location === undefined ? position : `${problem.location} ${position}`;
}

/**
 * The Problems view: import findings, pre-send expansion warnings, failed sends and message
 * validation in one table — severity, message, source, location and the request it belongs to.
 *
 * A row that knows its request is a button: clicking it opens (or focuses) that request's tab,
 * and — for a row with a position — selects the offending line in the editor.
 */
export function ProblemsView() {
  const items = useProblemsStore((state) => state.items);
  const requests = useProjectStore((state) => state.requests);
  const interfaces = useProjectStore((state) => state.interfaces);
  const apis = useProjectStore((state) => state.apis);
  const projects = useProjectStore((state) => state.projects);
  const projectOf = useProjectStore((state) => state.projectOf);
  // In the store, not local state, so the status bar's lint item can open the lint list (#745).
  const filter = useProblemsStore((state) => state.filter);
  const setFilter = useProblemsStore((state) => state.setFilter);
  // Filtered once: the row count the grid navigates and the rows it renders must be the same
  // list, and re-filtering for each would let them drift.
  const visible = filterProblems(items, filter);
  const { gridProps, rowProps } = useGridNavigation(visible.length);

  if (items.length === 0) {
    return <p className="text-sm text-fg-subtle">No problems found.</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Filter problems">
        {FILTERS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            data-testid={`problems-filter-${chip.id}`}
            aria-pressed={filter === chip.id}
            onClick={() => {
              setFilter(chip.id);
            }}
            className={`rounded-full border border-hairline px-2 py-0.5 text-xs ${
              filter === chip.id ? 'bg-accent-muted text-fg-default' : 'text-fg-subtle hover:bg-surface-raised'
            }`}
          >
            {chip.label}
            {chipCount(chip.id, items)}
          </button>
        ))}
      </div>
      {visible.length === 0 && (
        <p data-testid="problems-empty" className="text-sm text-fg-subtle">
          {filter === 'lint' ? 'No lint findings.' : 'No problems found.'}
        </p>
      )}

      {/* A grid rather than a plain list: every row is a record with the same columns, and
          Up/Down moving between rows is what a keyboard user expects of a Problems panel. */}
      <ul
        role="grid"
        aria-label="Problems"
        aria-rowcount={visible.length}
        className="flex min-h-0 flex-col gap-1 overflow-auto text-sm"
        {...gridProps}
      >
        {visible.map((item, index) => {
          const { source, severity, requestId, problem } = item;
          const Icon = severity === 'warning' ? AlertTriangle : XCircle;
          const isLint = source === 'lint';
          // A lint finding's pointer reads as a place in the API; the raw pointer and position stay in the tooltip.
          const location = isLint ? lintLocationLabel(problem.location ?? '') : locationLabel(problem);
          const locationTitle = isLint ? locationLabel(problem) : undefined;
          const requestName = requestId === undefined ? undefined : requests[requestId]?.name;
          const breadcrumb = breadcrumbOf(item, requests, interfaces, apis, projects, projectOf);
          const body = (
            <>
              <Icon
                size={13}
                aria-label={severity}
                className={`mt-0.5 shrink-0 ${severity === 'warning' ? 'text-status-warning' : 'text-status-danger'}`}
              />
              <span className={SOURCE_CLASS}>{problem.source ?? source}</span>
              <span className="min-w-0 flex-1 text-fg-default">
                {problem.message}
                {isLint && (
                  <span data-testid="problem-rule" className="ml-2 font-mono text-xs text-fg-faint">
                    {problem.code}
                  </span>
                )}
              </span>
              {breadcrumb !== undefined && (
                <span className="shrink-0 truncate text-xs text-fg-faint" title={breadcrumb}>
                  {breadcrumb}
                </span>
              )}
              {requestName !== undefined && <span className="shrink-0 text-xs text-fg-subtle">{requestName}</span>}
              {location !== undefined && (
                <span
                  data-testid="problem-location"
                  className="shrink-0 font-mono text-xs text-fg-subtle"
                  {...(locationTitle !== undefined ? { title: locationTitle } : {})}
                >
                  {location}
                </span>
              )}
            </>
          );

          if (isLint) {
            const apiId = item.groupId.slice('lint:'.length);
            return (
              <li key={key(item, index)} role="row" aria-rowindex={index + 1} {...rowProps(index)}>
                <div role="gridcell">
                  <button
                    type="button"
                    data-testid="problem-row"
                    onClick={() => {
                      revealLintFinding(apiId, problem.location ?? '');
                    }}
                    className="flex w-full items-start gap-2 rounded px-1 text-left hover:bg-surface-raised"
                  >
                    {body}
                  </button>
                </div>
              </li>
            );
          }

          if (requestId !== undefined) {
            return (
              <li key={key(item, index)} role="row" aria-rowindex={index + 1} {...rowProps(index)}>
                <div role="gridcell">
                  <button
                    type="button"
                    data-testid="problem-row"
                    onClick={() => {
                      // A GraphQL problem is located by JSON Pointer too, and revealed the same way.
                      if (source === 'contract' || source === 'graphql') {
                        revealContractProblem(requestId, problem.location ?? '');
                        return;
                      }
                      if (source === 'validation') {
                        revealProblem(requestId, item.direction ?? 'request', problem.line, problem.column);
                        return;
                      }
                      explorerActions.openRequest(requestId);
                    }}
                    className="flex w-full items-start gap-2 rounded px-1 text-left hover:bg-surface-raised"
                  >
                    {body}
                  </button>
                </div>
              </li>
            );
          }

          return (
            <li key={key(item, index)} role="row" aria-rowindex={index + 1} {...rowProps(index)}>
              <div role="gridcell" data-testid="problem-row" className="flex items-start gap-2 px-1">
                {body}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
