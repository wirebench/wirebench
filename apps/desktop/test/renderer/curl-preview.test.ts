import { describe, expect, it } from 'vitest';
import { describeCurlProblem, previewCurl } from '../../src/renderer/features/request-editor/curl-preview.js';

describe('previewCurl for a REST target', () => {
  it.each([
    ['curl https://api.test/pets', 'GET'],
    ["curl https://api.test/pets -d 'a=1'", 'POST'],
    ['curl -X delete https://api.test/pets/1', 'DELETE'],
    ['curl -XPATCH https://api.test/pets/1', 'PATCH'],
    ['curl -I https://api.test/pets', 'HEAD'],
    ["curl -G https://api.test/pets -d 'tag=dog'", 'GET'],
  ])('%s is a %s', (command, method) => {
    expect(previewCurl(command, 'rest').method).toBe(method);
  });

  it.each([
    ["curl https://api.test -F 'f=@a.png' -d x", 'multipart'],
    ["curl https://api.test --data-urlencode 'q=a b'", 'form'],
    ['curl https://api.test -d @body.json', 'file'],
    [`curl https://api.test --json '{"a":1}'`, 'JSON'],
    [`curl https://api.test -d '{"a":1}'`, 'raw'],
    ['curl https://api.test', undefined],
    ["curl -G https://api.test -d 'tag=dog'", undefined],
  ])('%s has a %s body', (command, kind) => {
    expect(previewCurl(command, 'rest').bodyKind).toBe(kind);
  });

  it('names the -u user and never the password, and reports no SOAP problems', () => {
    const preview = previewCurl("curl https://api.test -u 'ada:hunter2' -d @x.json", 'rest');
    expect(preview.basicUsername).toBe('ada');
    expect(JSON.stringify(preview)).not.toContain('hunter2');
    expect(preview.problems).toEqual([]);
  });

  it('keeps the SOAP problems for a SOAP target', () => {
    expect(previewCurl('curl https://api.test -u ada:pw -d @x.xml').problems).toEqual([
      'basic-auth-ignored',
      'data-from-file-unsupported',
    ]);
  });
});

describe('describeCurlProblem', () => {
  it('words the SOAP codes and passes the REST sentences through', () => {
    expect(describeCurlProblem('ignored-flag:--retry')).toBe('Ignored --retry');
    expect(describeCurlProblem('data-from-file-unsupported')).toContain('-d @file');
    expect(describeCurlProblem('Ignored --retry')).toBe('Ignored --retry');
  });
});
