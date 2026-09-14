/**
 * A short "how long ago" phrase for the sync badge and the panel's commit log — no date library,
 * `now` is always passed in explicitly so it is trivial to unit-test.
 */
export function formatRelative(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const diffSeconds = Math.max(0, Math.round((now.getTime() - then) / 1000));

  if (diffSeconds < 45) {
    return 'just now';
  }
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} hr ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${String(days)} day${days === 1 ? '' : 's'} ago`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return `${String(months)} mo ago`;
  }
  const years = Math.round(months / 12);
  return `${String(years)} yr${years === 1 ? '' : 's'} ago`;
}
