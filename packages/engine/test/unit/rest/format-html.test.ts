import { describe, expect, it } from 'vitest';
import { formatHtml } from '#protocol-rest/rest/format-html';

describe('formatHtml', () => {
  it('puts a one-line error page on one block tag per line, indented by depth', () => {
    expect(
      formatHtml('<!DOCTYPE html><html><head><title>500</title></head><body><h1>Oops</h1><hr></body></html>'),
    ).toBe(
      [
        '<!DOCTYPE html>',
        '<html>',
        '  <head>',
        '    <title>500</title>',
        '  </head>',
        '  <body>',
        '    <h1>',
        '      Oops',
        '    </h1>',
        '    <hr>',
        '  </body>',
        '</html>',
      ].join('\n'),
    );
  });

  it('keeps inline elements on one line with the text around them', () => {
    expect(formatHtml('<p>A <b>pet</b> store, <a href="/x">see\n   more</a><br><label for="q">Find</label></p>')).toBe(
      ['<p>', '  A <b>pet</b> store, <a href="/x">see more</a><br><label for="q">Find</label>', '</p>'].join('\n'),
    );
  });

  it('keeps script, style, pre and textarea content exactly as it came, a < included', () => {
    const out = formatHtml(
      '<body><script>if (a<b) { go(); }</script><style>p{color:red}\n  b{x:y}</style><div><pre>  x\n   y</pre></div><textarea> a\n</textarea></body>',
    );
    expect(out).toBe(
      [
        '<body>',
        '  <script>if (a<b) { go(); }</script>',
        '  <style>p{color:red}\n  b{x:y}</style>',
        '  <div>',
        '    <pre>  x\n   y</pre>',
        '  </div>',
        '  <textarea> a\n</textarea>',
        '</body>',
      ].join('\n'),
    );
  });

  it('treats a comment holding a > as one token, and self-closing tags as leaves', () => {
    expect(formatHtml('<div><!-- a > b --><img src="x"/><span>t</span></div>', 4)).toBe(
      ['<div>', '    <!-- a > b -->', '    <img src="x"/><span>t</span>', '</div>'].join('\n'),
    );
  });

  it('never goes below depth zero on a stray end tag, and keeps an unclosed script', () => {
    expect(formatHtml('</p><p>a</p><script>x')).toBe(['</p>', '<p>', '  a', '</p>', '<script>x'].join('\n'));
  });

  it('does not take a block tag starting with an inline name for an inline one', () => {
    expect(formatHtml('<article><abbr>a</abbr></article>')).toBe(
      ['<article>', '  <abbr>a</abbr>', '</article>'].join('\n'),
    );
  });
});
