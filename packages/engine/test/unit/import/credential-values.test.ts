import { describe, expect, it } from 'vitest';
import {
  blankJsonText,
  blankText,
  blankUrlCredentials,
  blankXmlText,
  scanXml,
} from '../../../src/import/credential-values.js';

function blankXml(text: string): { text: string; blanked: string[] } {
  const blanked = new Set<string>();
  return { text: blankXmlText(text, blanked), blanked: [...blanked] };
}

function timed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe('blankXmlText', () => {
  it('blanks the text of a credential-named element', () => {
    expect(blankXml('<login><user>bob</user><password>hunter2</password></login>')).toEqual({
      text: '<login><user>bob</user><password></password></login>',
      blanked: ['password'],
    });
  });

  it('blanks credential-named attributes in either quote style', () => {
    expect(blankXml(`<call apiKey='zzz' token="t1" id="7"/>`)).toEqual({
      text: `<call apiKey='' token="" id="7"/>`,
      blanked: ['apiKey', 'token'],
    });
  });

  it('reads a prefixed name by its local part, and never blanks a namespace declaration', () => {
    const { text, blanked } = blankXml(
      '<s:Envelope xmlns:token="urn:t" xmlns="urn:x"><ns:token>abc</ns:token><a ns:secret="s"/></s:Envelope>',
    );
    expect(text).toBe(
      '<s:Envelope xmlns:token="urn:t" xmlns="urn:x"><ns:token></ns:token><a ns:secret=""/></s:Envelope>',
    );
    expect(blanked).toEqual(['ns:token', 'ns:secret']);
  });

  it('keeps values made only of references, CDATA included, and empty or blank ones', () => {
    const xml =
      '<a><token>${t}</token><secret><![CDATA[${t}]]></secret><password>  </password><key/><b auth="{{x}}"/></a>';
    expect(blankXml(xml)).toEqual({ text: xml, blanked: [] });
  });

  it('blanks a literal CDATA run under a credential element, keeping the CDATA markers', () => {
    expect(blankXml('<token><![CDATA[s3cr3t]]></token>').text).toBe('<token><![CDATA[]]></token>');
  });

  it('leaves a non-credential child under a credential-named parent, and the white space between children', () => {
    const xml = '<auth>\n  <user>bob</user>\n  <realm>r</realm>\n</auth>';
    expect(blankXml(xml)).toEqual({ text: xml, blanked: [] });
  });

  it('blanks each run of mixed content under a credential element', () => {
    expect(blankXml('<token>abc<b>keep</b>def</token>').text).toBe('<token><b>keep</b></token>');
  });

  it('skips comments, processing instructions and a doctype with an internal subset', () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY e "<token>x</token>">]><a><!-- <token>fake</token> --><v>1</v></a>';
    expect(blankXml(xml)).toEqual({ text: xml, blanked: [] });
  });

  it('reads past a > inside a quoted attribute value', () => {
    expect(blankXml('<a note="1 > 0" token="t"><secret>s</secret></a>').text).toBe(
      '<a note="1 > 0" token=""><secret></secret></a>',
    );
  });

  it('blanks an unterminated credential attribute value or CDATA run to the end of the text', () => {
    expect(blankXml('<a id="1" token="lit-1')).toEqual({ text: '<a id="1" token="', blanked: ['token'] });
    expect(blankXml('<a><secret><![CDATA[lit-2')).toEqual({ text: '<a><secret><![CDATA[', blanked: ['secret'] });
    expect(blankXml('<a token="${t}')).toEqual({ text: '<a token="${t}', blanked: [] });
  });

  it('copies the rest as written from an unterminated tag, attribute, CDATA or comment', () => {
    for (const xml of [
      '<a><token>x</token><b c',
      '<a><token>x</token><b id="unterminated',
      '<a><token>x</token><other><![CDATA[y',
      '<a><token>x</token><!-- <secret>y</secret>',
    ]) {
      const { text } = blankXml(xml);
      expect(text, xml).toBe(xml.replace('<token>x</token>', '<token></token>'));
    }
  });

  it('blanks a trailing text run under an unclosed credential element, and reads a lone < as text', () => {
    expect(blankXml('<token>a < b').text).toBe('<token>');
  });

  it('closes the innermost element on a mismatched end tag', () => {
    expect(blankXml('<token><b>x</c>y</token>').text).toBe('<token><b>x</c></token>');
  });

  it('is linear on hostile input', () => {
    // 256 KB: a quadratic scan takes seconds here, and a linear one stays well inside the bound even
    // under the coverage run's instrumentation.
    const n = 256 * 1024;
    for (const unit of ['<token', '<a b="', '<!--', '<![CDATA[', '<!DOCTYPE[', '<token>a<', '<<']) {
      const input = unit.repeat(Math.ceil(n / unit.length));
      expect(
        timed(() => blankXml(input)),
        unit,
      ).toBeLessThan(200);
    }
  });

  it('is linear in a long element name times many runs below it', () => {
    const name = 'a'.repeat(10_000);
    for (const runs of ['x<b/>'.repeat(50_000), 'x<!---->'.repeat(50_000)]) {
      const input = `<${name}>${runs}`;
      expect(
        timed(() => blankXml(input)),
        runs.slice(0, 8),
      ).toBeLessThan(200);
    }
  });
});

describe('scanXml', () => {
  it('puts each answer in place and keeps a value it answers undefined for', () => {
    const seen: string[] = [];
    const out = scanXml('<a token="t"><secret>s</secret><password>p</password></a>', (name, value) => {
      seen.push(`${name}=${value}`);
      return name === 'password' ? undefined : '*';
    });
    expect(out).toBe('<a token="*"><secret>*</secret><password>p</password></a>');
    expect(seen).toEqual(['token=t', 'secret=s', 'password=p']);
  });
});

describe('blankText', () => {
  it('blanks XML by any content type naming xml, and text opening with < when there is none', () => {
    for (const type of ['application/xml', 'text/xml; charset=utf-8', 'application/soap+xml', undefined]) {
      const blanked = new Set<string>();
      expect(blankText('  <a><token>x</token></a>', type, blanked), String(type)).toBe('  <a><token></token></a>');
      expect([...blanked]).toEqual(['token']);
    }
  });

  it('keeps plain text, and XML under a content type that does not name it', () => {
    const blanked = new Set<string>();
    expect(blankText('token=x', undefined, blanked)).toBe('token=x');
    expect(blankText('<token>x</token>', 'text/plain', blanked)).toBe('<token>x</token>');
    expect(blanked.size).toBe(0);
  });
});

describe('blankJsonText', () => {
  it('blanks literal string and number values under credential keys', () => {
    const blanked = new Set<string>();
    expect(blankJsonText('{"token":"abc","password":12,"id":3}', blanked)).toBe('{"token":"","password":"","id":3}');
    expect([...blanked]).toEqual(['token', 'password']);
  });

  it('leaves an escaped key-like run inside a string value alone', () => {
    const json = '{"note":"v\\"token\\": 1"}';
    const blanked = new Set<string>();
    expect(blankJsonText(json, blanked)).toBe(json);
    expect(blanked.size).toBe(0);
  });

  it('blanks in place when the text does not parse, and keeps references', () => {
    const blanked = new Set<string>();
    expect(blankJsonText('{"token": ${t}, "secret": "${s}", "auth": "x"', blanked)).toBe(
      '{"token": ${t}, "secret": "${s}", "auth": ""',
    );
  });

  it('is linear on an unterminated string full of escaped quotes', () => {
    const input = '"a' + '\\"'.repeat(200_000);
    expect(timed(() => blankJsonText(input, new Set()))).toBeLessThan(200);
    const keyed = '{"token": "a' + '\\"'.repeat(200_000);
    expect(timed(() => blankJsonText(keyed, new Set()))).toBeLessThan(200);
  });

  it('is linear on long whitespace runs after strings, with or without a colon', () => {
    for (const input of [
      '"a"' + ' '.repeat(400_000),
      '"token"' + ' '.repeat(400_000) + ':',
      ('"a"' + ' '.repeat(40)).repeat(10_000),
    ]) {
      expect(timed(() => blankJsonText(input, new Set()))).toBeLessThan(200);
    }
    expect(blankJsonText('{"token" :\n "abc", "n": 1}', new Set())).toBe('{"token" :\n "", "n": 1}');
  });
});

describe('blankUrlCredentials', () => {
  it('cuts literal user info and blanks literal credential query values, keeping references and the fragment', () => {
    const blanked = new Set<string>();
    expect(
      blankUrlCredentials('https://u:p@auth.example/token?client_secret=s&aud=x&api_key=${#Project#k}#frag', blanked),
    ).toEqual({ url: 'https://auth.example/token?client_secret=&aud=x&api_key=${#Project#k}#frag', stripped: true });
    expect([...blanked]).toEqual(['client_secret']);
  });

  it('keeps a URL without a query or user info as written', () => {
    const blanked = new Set<string>();
    expect(blankUrlCredentials('${#Project#base}/token', blanked)).toEqual({
      url: '${#Project#base}/token',
      stripped: false,
    });
  });
});
