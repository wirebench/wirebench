/**
 * Case-insensitive helpers for the header maps the transport passes around.
 *
 * HTTP header names are case-insensitive but the maps here are plain objects, so every
 * lookup and every override has to compare case-folded names or a caller-supplied
 * `Content-Type` would silently sit next to a computed `content-type`.
 */

/** Case-insensitively merges `override` onto `base`, letting `override`'s casing win for shared keys. */
export function mergeHeaders(
  base: Readonly<Record<string, string>>,
  override: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  const lowerToKey = new Map(Object.keys(merged).map((key) => [key.toLowerCase(), key]));
  for (const [key, value] of Object.entries(override)) {
    const existingKey = lowerToKey.get(key.toLowerCase());
    if (existingKey !== undefined && existingKey !== key) {
      delete merged[existingKey];
    }
    merged[key] = value;
    lowerToKey.set(key.toLowerCase(), key);
  }
  return merged;
}

/** Sets a header, replacing any differently-cased entry of the same name. */
export function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase() && key !== name) {
      delete headers[key];
    }
  }
  headers[name] = value;
}

/** Returns a copy of `headers` with `name` removed, case-insensitively. */
export function withoutHeader(headers: Readonly<Record<string, string>>, name: string): Record<string, string> {
  const lower = name.toLowerCase();
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) result[key] = value;
  }
  return result;
}

/** Looks up a header case-insensitively. */
export function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}
