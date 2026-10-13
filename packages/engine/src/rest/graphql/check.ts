/**
 * A GraphQL response checked (#77): every entry of its `errors` array, and its `data` against the
 * operation that was sent and the API's schema. Errors fail a run; a mismatch between `data` and the
 * schema is a warning, as a REST contract violation is. Messages name the schema's side only: a
 * value from the body is never copied into one, except an error's own message, which is the point.
 */
import {
  getNamedType,
  isAbstractType,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  parse,
} from 'graphql';
import type {
  DocumentNode,
  FragmentDefinitionNode,
  GraphQLCompositeType,
  GraphQLOutputType,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql';

/** One entry of the response's `errors` array. */
export interface GraphqlResponseError {
  readonly message: string;
  /** The error's `path`, as the server gave it. */
  readonly path?: readonly (string | number)[];
  /** `/errors/<index>`: where the error sits in the body. */
  readonly pointer: string;
}

/** A place where `data` does not match what the operation and the schema promise. */
export interface GraphqlDataProblem {
  /** JSON Pointer into the body, `/data/...`. */
  readonly pointer: string;
  readonly message: string;
}

/**
 * How far the check got. `checked`: the data was compared with the schema. `no-schema`: the API has
 * none. `no-query`: the query sent does not parse or names no operation the schema has. `skipped`:
 * the body is too large. `not-graphql`: the body is not a GraphQL response at all.
 */
export type GraphqlSchemaCheck = 'checked' | 'no-schema' | 'no-query' | 'skipped' | 'not-graphql';

/** What {@link checkGraphqlResponse} found. */
export interface GraphqlCheckResult {
  readonly errors: readonly GraphqlResponseError[];
  readonly problems: readonly GraphqlDataProblem[];
  readonly schema: GraphqlSchemaCheck;
}

/** What {@link checkGraphqlResponse} is given. */
export interface GraphqlCheckInput {
  /** The response body as text. */
  readonly bodyText: string;
  /** The query as sent, expanded. */
  readonly query: string;
  readonly operationName?: string;
  readonly schema?: GraphQLSchema;
}

/** Above this, nothing is parsed: the check is `skipped`. */
export const GRAPHQL_CHECK_MAX_BYTES = 1024 * 1024;
const MAX_PROBLEMS = 50;
const MAX_MESSAGE = 300;

function cap(message: string): string {
  return message.length <= MAX_MESSAGE ? message : `${message.slice(0, MAX_MESSAGE - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** RFC 6901: `~` and `/` in a key are escaped. */
function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function errorsOf(document: Record<string, unknown>): GraphqlResponseError[] {
  const errors = document['errors'];
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, MAX_PROBLEMS).map((entry: unknown, index) => {
    const message =
      isRecord(entry) && typeof entry['message'] === 'string' ? entry['message'] : 'An error with no message';
    const path =
      isRecord(entry) && Array.isArray(entry['path'])
        ? (entry['path'] as unknown[]).filter(
            (step): step is string | number => typeof step === 'string' || typeof step === 'number',
          )
        : undefined;
    return { message: cap(message), ...(path !== undefined ? { path } : {}), pointer: `/errors/${index}` };
  });
}

/** One selected field of an object: its response key's type and sub-selection. */
interface Selected {
  readonly type: GraphQLOutputType;
  readonly selections?: SelectionSetNode;
  /** Selected only on some runtime types, or behind `@include`/`@skip`: absence is not a problem. */
  readonly optional: boolean;
}

class DataChecker {
  readonly problems: GraphqlDataProblem[] = [];

  constructor(
    private readonly schema: GraphQLSchema,
    private readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>,
    /** With errors, nulls and missing fields are expected where a field failed. */
    private readonly lenient: boolean,
  ) {}

  private report(at: string, message: string): void {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push({ pointer: at, message: cap(message) });
  }

  /** The fields a selection set selects on `type`, by response key. */
  private collect(
    type: GraphQLCompositeType,
    runtime: string | undefined,
    selections: SelectionSetNode,
    optional: boolean,
    out: Map<string, Selected>,
  ): void {
    for (const selection of selections.selections) {
      const conditional =
        optional || (selection.directives?.some((d) => d.name.value === 'include' || d.name.value === 'skip') ?? false);
      if (selection.kind === Kind.FIELD) {
        const key = selection.alias?.value ?? selection.name.value;
        if (selection.name.value === '__typename') {
          out.set(key, { type: this.schema.getType('String') as GraphQLOutputType, optional: conditional });
          continue;
        }
        if (!isObjectType(type) && !('getFields' in type)) continue;
        const field = (type as { getFields(): Record<string, { type: GraphQLOutputType }> }).getFields()[
          selection.name.value
        ];
        if (field === undefined) continue;
        const previous = out.get(key);
        out.set(key, {
          type: field.type,
          ...(selection.selectionSet !== undefined ? { selections: selection.selectionSet } : {}),
          optional: conditional && (previous?.optional ?? true),
        });
        continue;
      }
      const condition =
        selection.kind === Kind.INLINE_FRAGMENT
          ? selection.typeCondition?.name.value
          : this.fragments.get(selection.name.value)?.typeCondition.name.value;
      const set =
        selection.kind === Kind.INLINE_FRAGMENT
          ? selection.selectionSet
          : this.fragments.get(selection.name.value)?.selectionSet;
      if (set === undefined) continue;
      if (condition === undefined || condition === type.name) {
        this.collect(type, runtime, set, conditional, out);
        continue;
      }
      if (runtime !== undefined) {
        // The runtime type is known: a fragment on it, or on an abstract type it belongs to, applies.
        const runtimeType = this.schema.getType(runtime);
        const conditionType = this.schema.getType(condition);
        if (runtimeType === undefined || conditionType === undefined || !isObjectType(runtimeType)) continue;
        const applies =
          condition === runtime || (isAbstractType(conditionType) && this.schema.isSubType(conditionType, runtimeType));
        if (applies) this.collect(runtimeType, runtime, set, conditional, out);
        continue;
      }
      // Not known: what the fragment selects may or may not be there.
      const conditionType = this.schema.getType(condition);
      if (conditionType !== undefined && (isObjectType(conditionType) || isAbstractType(conditionType))) {
        this.collect(conditionType as GraphQLCompositeType, undefined, set, true, out);
      }
    }
  }

  object(value: unknown, type: GraphQLCompositeType, selections: SelectionSetNode, at: string): void {
    if (!isRecord(value)) {
      this.report(at, `Expected an object of type ${type.name}`);
      return;
    }
    const typename = typeof value['__typename'] === 'string' ? value['__typename'] : undefined;
    let runtime: GraphQLCompositeType = type;
    if (isAbstractType(type) && typename !== undefined) {
      const named = this.schema.getType(typename);
      if (named !== undefined && isObjectType(named) && this.schema.isSubType(type, named)) runtime = named;
      else this.report(pointer(at, '__typename'), `Not a possible type of ${type.name}`);
    }
    const selected = new Map<string, Selected>();
    this.collect(runtime, isObjectType(runtime) ? runtime.name : undefined, selections, false, selected);
    for (const [key, field] of selected) {
      if (!(key in value)) {
        if (!field.optional && !this.lenient) this.report(pointer(at, key), `Missing the selected field "${key}"`);
        continue;
      }
      this.value(value[key], field.type, field.selections, pointer(at, key));
    }
    for (const key of Object.keys(value)) {
      if (!selected.has(key)) this.report(pointer(at, key), `The field "${key}" was not selected`);
    }
  }

  value(value: unknown, type: GraphQLOutputType, selections: SelectionSetNode | undefined, at: string): void {
    if (isNonNullType(type)) {
      if (value === null) {
        if (!this.lenient) this.report(at, `null where ${String(type)} is non-null`);
        return;
      }
      this.value(value, type.ofType, selections, at);
      return;
    }
    if (value === null) return;
    if (isListType(type)) {
      if (!Array.isArray(value)) {
        this.report(at, `Expected a list of ${String(type.ofType)}`);
        return;
      }
      value.forEach((item: unknown, index) => this.value(item, type.ofType, selections, pointer(at, index)));
      return;
    }
    if (isScalarType(type)) {
      const ok = scalarFits(type.name, value);
      if (!ok) this.report(at, `Not a ${type.name}`);
      return;
    }
    if (isEnumType(type)) {
      if (typeof value !== 'string' || type.getValue(value) === undefined)
        this.report(at, `Not a value of the enum ${type.name}`);
      return;
    }
    if (selections !== undefined) this.object(value, getNamedType(type) as GraphQLCompositeType, selections, at);
  }
}

/** Whether a JSON value can be a built-in scalar; a custom scalar takes anything. */
function scalarFits(name: string, value: unknown): boolean {
  switch (name) {
    case 'Int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'Float':
      return typeof value === 'number';
    case 'String':
      return typeof value === 'string';
    case 'Boolean':
      return typeof value === 'boolean';
    case 'ID':
      return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
    default:
      return true;
  }
}

function operationOf(document: DocumentNode, name: string | undefined): OperationDefinitionNode | undefined {
  const operations = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (name !== undefined && name !== '') return operations.find((op) => op.name?.value === name);
  return operations.length === 1 ? operations[0] : undefined;
}

/**
 * Checks one GraphQL response. A body that is not a JSON object with `data` or `errors` is
 * `not-graphql`, with nothing reported.
 */
export function checkGraphqlResponse(input: GraphqlCheckInput): GraphqlCheckResult {
  if (Buffer.byteLength(input.bodyText, 'utf8') > GRAPHQL_CHECK_MAX_BYTES) {
    return { errors: [], problems: [], schema: 'skipped' };
  }
  let document: unknown;
  try {
    document = JSON.parse(input.bodyText) as unknown;
  } catch {
    return { errors: [], problems: [], schema: 'not-graphql' };
  }
  if (!isRecord(document) || (!('data' in document) && !('errors' in document))) {
    return { errors: [], problems: [], schema: 'not-graphql' };
  }
  const errors = errorsOf(document);
  if (input.schema === undefined) return { errors, problems: [], schema: 'no-schema' };
  let query: DocumentNode;
  try {
    query = parse(input.query);
  } catch {
    return { errors, problems: [], schema: 'no-query' };
  }
  const operation = operationOf(query, input.operationName);
  const root = operation === undefined ? undefined : input.schema.getRootType(operation.operation);
  if (operation === undefined || root === undefined || root === null)
    return { errors, problems: [], schema: 'no-query' };
  const fragments = new Map(
    query.definitions
      .filter((d): d is FragmentDefinitionNode => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d] as const),
  );
  const checker = new DataChecker(input.schema, fragments, errors.length > 0);
  const data = document['data'];
  if (data !== undefined && data !== null) checker.object(data, root, operation.selectionSet, '/data');
  return { errors, problems: checker.problems, schema: 'checked' };
}
