/**
 * Splits ignore-rule text into individual rules: one per line, blank lines
 * and `#`-comment lines skipped. The textarea in the Snapshot tab saves its
 * raw text through this before it's stored as the sidecar's `ignore` array.
 */
export function parseIgnoreRules(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Splits a diff path or an ignore rule into its `/`-separated segments. */
function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** The local name and, if present, the 1-based `[n]` index of one path segment. */
function parseSegment(segment: string): { name: string; index?: string } {
  const match = /^(.*)\[(\d+)]$/.exec(segment);
  if (match === null) {
    return { name: segment };
  }
  const index = match[2];
  return index === undefined ? { name: match[1] ?? '' } : { name: match[1] ?? '', index };
}

/** Whether one path segment matches one rule segment. */
function segmentMatches(pathSegment: string, ruleSegment: string): boolean {
  if (ruleSegment === '*') {
    return true;
  }
  const rule = parseSegment(ruleSegment);
  const path = parseSegment(pathSegment);
  if (rule.name !== path.name) {
    return false;
  }
  // "A segment without [n] matches any index" — only compare the index when the
  // rule itself names one.
  if (rule.index === undefined) {
    return true;
  }
  return rule.index === path.index;
}

/**
 * Tests whether `rule` covers `path`, either directly or because `path` is a
 * descendant of the path the rule names. A rule's `*` segment matches any
 * one segment; a leading `//` means "at any depth"; a segment with no
 * `[n]` matches every index of that name.
 */
export function matchesIgnoreRule(path: string, rule: string): boolean {
  const anyDepth = rule.startsWith('//');
  const ruleSegments = segments(rule);
  const pathSegments = segments(path);
  if (ruleSegments.length === 0) {
    return false;
  }

  const matchesFrom = (start: number): boolean => {
    if (ruleSegments.length > pathSegments.length - start) {
      return false;
    }
    for (let i = 0; i < ruleSegments.length; i += 1) {
      const ruleSegment = ruleSegments[i];
      const pathSegment = pathSegments[start + i];
      if (ruleSegment === undefined || pathSegment === undefined || !segmentMatches(pathSegment, ruleSegment)) {
        return false;
      }
    }
    return true;
  };

  if (anyDepth) {
    for (let start = 0; start <= pathSegments.length - ruleSegments.length; start += 1) {
      if (matchesFrom(start)) {
        return true;
      }
    }
    return false;
  }

  return matchesFrom(0);
}
