import { describe, expect, it } from 'vitest';
import { notCurlReason, stripShellPrompt } from '../../../src/http/curl-start.js';
import { fromRestCurl } from '../../../src/rest/curl.js';
import { fromCurl } from '../../../src/soap/curl.js';

describe('notCurlReason', () => {
  it('accepts curl and curl.exe, with or without a $ prompt or leading space', () => {
    expect(notCurlReason('curl https://api.test')).toBeUndefined();
    expect(notCurlReason('curl.exe https://api.test')).toBeUndefined();
    expect(notCurlReason('$ curl https://api.test')).toBeUndefined();
    expect(notCurlReason('  \n curl https://api.test')).toBeUndefined();
  });

  it('says nothing about empty text', () => {
    expect(notCurlReason('')).toBeUndefined();
    expect(notCurlReason('   ')).toBeUndefined();
  });

  it('names the word another command starts with', () => {
    expect(notCurlReason('wget http://example.com')).toContain('starts with “wget”');
    expect(notCurlReason('https://api.test/pets')).toContain('starts with “https://api.test/pets”');
    expect(notCurlReason('$ http GET api.test')).toContain('starts with “http”');
    expect(notCurlReason('curly https://api.test')).toBeDefined();
  });
});

describe('stripShellPrompt', () => {
  it('drops a leading $ prompt only', () => {
    expect(stripShellPrompt('$ curl x')).toBe('curl x');
    expect(stripShellPrompt('curl -d "$ x" y')).toBe('curl -d "$ x" y');
  });
});

describe('the parsers read a command pasted with its prompt', () => {
  it('REST keeps the URL rather than reading the $ as one', () => {
    expect(fromRestCurl('$ curl https://api.test/pets').request.url).toBe('https://api.test/pets');
  });

  it('SOAP keeps the endpoint', () => {
    expect(fromCurl('$ curl https://api.test/calc.asmx').input.endpoint).toBe('https://api.test/calc.asmx');
  });
});
