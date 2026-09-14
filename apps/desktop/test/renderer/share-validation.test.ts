import { describe, expect, it } from 'vitest';
import { validateBranchName, validateRemoteUrl } from '../../src/renderer/features/workspace/share-validation.js';

describe('validateRemoteUrl', () => {
  it('accepts an empty remote (the field is optional when sharing)', () => {
    expect(validateRemoteUrl('')).toEqual({ valid: true });
    expect(validateRemoteUrl('   ')).toEqual({ valid: true });
  });

  it('accepts https, ssh, file and scp-like remotes', () => {
    expect(validateRemoteUrl('https://example.com/team/workspace.git').valid).toBe(true);
    expect(validateRemoteUrl('ssh://git@example.com/team/workspace.git').valid).toBe(true);
    expect(validateRemoteUrl('file:///srv/git/workspace.git').valid).toBe(true);
    expect(validateRemoteUrl('git@gitlab.example.com:team/workspace.git').valid).toBe(true);
  });

  it('rejects ext:: and other disallowed schemes', () => {
    expect(validateRemoteUrl('ext::sh -c false').valid).toBe(false);
    expect(validateRemoteUrl('git://example.com/repo.git').valid).toBe(false);
    expect(validateRemoteUrl('not-a-url').valid).toBe(false);
  });

  it('rejects a user or host starting with -', () => {
    expect(validateRemoteUrl('-oProxyCommand=x@host:path').valid).toBe(false);
    expect(validateRemoteUrl('user@-host:path').valid).toBe(false);
  });

  it('rejects whitespace and control characters', () => {
    expect(validateRemoteUrl('https://example.com/a b').valid).toBe(false);
  });

  it('never echoes the checked value in its message', () => {
    const secret = 'ext::do-not-print-me';
    const result = validateRemoteUrl(secret);
    expect(result.message).toBeDefined();
    expect(result.message).not.toContain(secret);
  });
});

describe('validateBranchName', () => {
  it('accepts ordinary branch names', () => {
    expect(validateBranchName('main').valid).toBe(true);
    expect(validateBranchName('feature/shared-workspaces').valid).toBe(true);
  });

  it('rejects empty, leading -, and forbidden characters', () => {
    expect(validateBranchName('').valid).toBe(false);
    expect(validateBranchName('-x').valid).toBe(false);
    expect(validateBranchName('a b').valid).toBe(false);
    expect(validateBranchName('a~b').valid).toBe(false);
    expect(validateBranchName('a\\b').valid).toBe(false);
  });

  it('rejects .. @{ leading/trailing slash, //, trailing .lock or ., and dot components', () => {
    expect(validateBranchName('a..b').valid).toBe(false);
    expect(validateBranchName('a@{b').valid).toBe(false);
    expect(validateBranchName('/a').valid).toBe(false);
    expect(validateBranchName('a/').valid).toBe(false);
    expect(validateBranchName('a//b').valid).toBe(false);
    expect(validateBranchName('a.lock').valid).toBe(false);
    expect(validateBranchName('a.').valid).toBe(false);
    expect(validateBranchName('a/.b').valid).toBe(false);
    expect(validateBranchName('@').valid).toBe(false);
  });
});
