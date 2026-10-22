/** An operation as the name of its generated request needs it: one of these per operation per binding. */
export interface NamedOperation {
  readonly name: string;
  /** The binding's full name; tells the bindings apart. */
  readonly binding: string;
  /** The binding's local name, shown when two bindings share a SOAP version. */
  readonly bindingLocal: string;
  readonly soapVersion: '1.1' | '1.2' | 'none';
}

/**
 * The name a generated SOAP request starts with (#726): its operation's ("Add"), so the HTTP Log, History,
 * Quick Open, the Runner and the delete prompt tell requests apart. Every request used to be "Request 1".
 * An operation offered by more than one binding of `all` names the SOAP version ("Add (SOAP 1.2)"), or the
 * binding's local name where two of those bindings share a version.
 */
export function generatedRequestName(operation: NamedOperation, all: readonly NamedOperation[]): string {
  const bindings = new Set(all.filter((o) => o.name === operation.name).map((o) => o.binding));
  if (bindings.size <= 1) return operation.name;
  const sameVersion = new Set(
    all.filter((o) => o.name === operation.name && o.soapVersion === operation.soapVersion).map((o) => o.binding),
  );
  return operation.soapVersion !== 'none' && sameVersion.size === 1
    ? `${operation.name} (SOAP ${operation.soapVersion})`
    : `${operation.name} (${operation.bindingLocal})`;
}
