/**
 * A REST request's name as a list shows it beside its method badge.
 *
 * Imports used to name a request with no summary by its method and path (`GET /pets/{id}`), so next
 * to the badge it read `GET GET /pets/{id}`. New imports name it by path alone; a name stored before
 * that still starts with its own method, and that prefix is left out wherever the badge already says
 * it. The match is exact and case-sensitive, so a summary such as `Get pets` is never cut short.
 */
export function requestDisplayName(name: string, method: string | undefined): string {
  if (method === undefined || method.length === 0) {
    return name;
  }
  const prefix = `${method.toUpperCase()} `;
  if (!name.startsWith(prefix)) {
    return name;
  }
  const rest = name.slice(prefix.length).trimStart();
  // A name that is only the method keeps it: an empty row would say less than a doubled word.
  return rest.length > 0 ? rest : name;
}

/**
 * A request's `Api/Folder/Request` path (the Runner's list) with its last part shown as
 * {@link requestDisplayName} shows the name. A name that is itself a path (`/pets/{id}`) is set off
 * with `›`, so the row never reads `Pets//pets/{id}` as if the folder held a `pets` folder.
 */
export function pathDisplayName(path: string, name: string, method: string | undefined): string {
  if (!path.endsWith(`/${name}`)) {
    return path;
  }
  const shown = requestDisplayName(name, method);
  const container = path.slice(0, path.length - name.length - 1);
  return shown.startsWith('/') ? `${container} › ${shown}` : `${container}/${shown}`;
}
