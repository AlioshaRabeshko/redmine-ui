import { describe, expect, it } from 'vitest';
import { normalizeRedmineTextFormat, prepareRedmineSource, redminePreviewSource, serializeRedmineSource } from './redmineFormatting';

describe('Redmine formatter adapter', () => {
  it('recognizes only confirmed formatter names and never guesses Markdown', () => {
    expect(normalizeRedmineTextFormat('textile')).toBe('textile');
    expect(normalizeRedmineTextFormat('Common Mark')).toBe('common_mark');
    expect(normalizeRedmineTextFormat(undefined)).toBe('unsupported');
    expect(normalizeRedmineTextFormat('html')).toBe('unsupported');
    expect(prepareRedmineSource('# title', undefined).visualSupported).toBe(false);
  });

  it('converts the supported Textile subset and round-trips its bold/italic markers', () => {
    const source = 'h2. Heading\n\n*bold* and _italic_ and -strike- and @code@\n\n* parent\n** child';
    const prepared = prepareRedmineSource(source, 'textile');
    expect(prepared.markdown).toContain('## Heading');
    expect(prepared.markdown).toContain('**bold** and *italic* and ~~strike~~ and `code`');
    expect(serializeRedmineSource(prepared.markdown, prepared)).toBe(source);
  });

  it('preserves an entire unknown Textile macro/table/code block as one source atom', () => {
    const source = 'Before\n\n{{custom_macro(arg)\nline two\n}}\n\n|a|b|\n|1|2|\n\nbc. puts "exact"\n  more code\n\nAfter';
    const prepared = prepareRedmineSource(source, 'textile');
    expect(prepared.opaque.size).toBe(3);
    expect([...prepared.opaque.values()].map((item) => item.raw)).toContain('{{custom_macro(arg)\nline two\n}}');
    const modified = prepared.markdown.replace('Before', 'Before edited');
    const serialized = serializeRedmineSource(modified, prepared);
    expect(serialized).toContain('{{custom_macro(arg)\nline two\n}}');
    expect(serialized).toContain('|a|b|\n|1|2|');
    expect(serialized).toContain('bc. puts "exact"\n  more code');
    expect(serialized).toContain('Before edited');
  });

  it('preserves Textile extended block quotes instead of partially parsing their prefix', () => {
    const source = 'Before\n\nbq.. Extended quote\ncontinuation with *markup*\n\nAfter';
    const prepared = prepareRedmineSource(source, 'textile');
    expect([...prepared.opaque.values()].map((item) => item.raw)).toContain('bq.. Extended quote\ncontinuation with *markup*');
    const serialized = serializeRedmineSource(prepared.markdown.replace('Before', 'Before edited'), prepared);
    expect(serialized).toContain('bq.. Extended quote\ncontinuation with *markup*');
    expect(serialized).not.toContain('> . Extended quote');
    expect(redminePreviewSource(source, 'textile').content).toContain('> Extended quote\n> continuation with **markup**');
  });

  it('preserves Markdown tables and task lists as complete opaque blocks', () => {
    const source = 'Top\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] checked\n- [ ] open\n\nEnd';
    const prepared = prepareRedmineSource(source, 'common_mark');
    expect([...prepared.opaque.values()].map((item) => item.raw)).toEqual([
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
      '- [x] checked\n- [ ] open',
    ]);
    const serialized = serializeRedmineSource(prepared.markdown.replace('Top', 'Top edit'), prepared);
    expect(serialized).toContain('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(serialized).toContain('- [x] checked\n- [ ] open');
  });

  it('renders Markdown reference images as source-backed nodes and preserves links, footnotes, and definitions', () => {
    const source = [
      'Paragraph ![screen][asset] and [guide][docs] with a note[^details].',
      '',
      '[asset]: attachments/screen.png',
      '[docs]: https://docs.example.test/guide',
      '[^details]: First line',
      '  continuation line',
      '',
      'Editable paragraph.',
    ].join('\n');
    const prepared = prepareRedmineSource(source, 'common_mark');
    expect([...prepared.images.values()]).toContainEqual({
      raw: '![screen][asset]', source: 'attachments/screen.png', alt: 'screen',
    });
    expect([...prepared.opaque.values()].map((item) => item.raw)).toEqual(expect.arrayContaining([
      '[guide][docs]', '[^details]', '[asset]: attachments/screen.png',
      '[docs]: https://docs.example.test/guide', '[^details]: First line\n  continuation line',
    ]));
    const serialized = serializeRedmineSource(prepared.markdown.replace('Editable paragraph.', 'Edited paragraph.'), prepared);
    expect(serialized).toContain('![screen][asset] and [guide][docs] with a note[^details].');
    expect(serialized).toContain('[asset]: attachments/screen.png\n[docs]: https://docs.example.test/guide');
    expect(serialized).toContain('[^details]: First line\n  continuation line');
  });

  it('preserves exact Markdown inline, reference, and raw HTML image source across neighboring edits', () => {
    const source = [
      'Before ![inline alt](<https://redmine.example.test/attachments/download/7/screen.png> "inline title").',
      '',
      '![Reference chart][diagram]',
      '',
      '[diagram]: <https://redmine.example.test/attachments/download/8/chart.png> "reference title"',
      '',
      '<img data-token="kept" alt="Raw chart" src="/attachments/download/9/raw.png" width="200">',
      '',
      'Editable paragraph.',
    ].join('\n');
    const prepared = prepareRedmineSource(source, 'common_mark');
    expect([...prepared.images.values()]).toEqual([
      { raw: '![inline alt](<https://redmine.example.test/attachments/download/7/screen.png> "inline title")', source: 'https://redmine.example.test/attachments/download/7/screen.png', alt: 'inline alt' },
      { raw: '![Reference chart][diagram]', source: 'https://redmine.example.test/attachments/download/8/chart.png', alt: 'Reference chart' },
      { raw: '<img data-token="kept" alt="Raw chart" src="/attachments/download/9/raw.png" width="200">', source: '/attachments/download/9/raw.png', alt: 'Raw chart' },
    ]);
    const serialized = serializeRedmineSource(prepared.markdown.replace('Editable paragraph.', 'Edited paragraph.'), prepared);
    expect(serialized).toContain('![inline alt](<https://redmine.example.test/attachments/download/7/screen.png> "inline title")');
    expect(serialized).toContain('![Reference chart][diagram]');
    expect(serialized).toContain('[diagram]: <https://redmine.example.test/attachments/download/8/chart.png> "reference title"');
    expect(serialized).toContain('<img data-token="kept" alt="Raw chart" src="/attachments/download/9/raw.png" width="200">');
    expect(serialized).toContain('Edited paragraph.');
  });

  it('does not turn Markdown image-like source in code or Redmine macros into image nodes', () => {
    const tick = String.fromCharCode(96);
    const source = [
      '![real](https://redmine.example.test/attachments/download/7/real.png)',
      '',
      tick + '![inline code](https://redmine.example.test/attachments/download/8/code.png)' + tick,
      '',
      '{{custom_macro(![macro image](https://redmine.example.test/attachments/download/9/macro.png))}}',
      '',
      tick.repeat(3) + 'markdown',
      '![fenced code](https://redmine.example.test/attachments/download/10/fenced.png)',
      tick.repeat(3),
    ].join('\n');
    const prepared = prepareRedmineSource(source, 'markdown');
    expect([...prepared.images.values()].map((image) => image.raw)).toEqual([
      '![real](https://redmine.example.test/attachments/download/7/real.png)',
    ]);
    const serialized = serializeRedmineSource(prepared.markdown, prepared);
    expect(serialized).toContain('{{custom_macro(![macro image](https://redmine.example.test/attachments/download/9/macro.png))}}');
    expect(serialized).toContain(tick.repeat(3) + 'markdown\n![fenced code](https://redmine.example.test/attachments/download/10/fenced.png)\n' + tick.repeat(3));
  });

  it('creates source-backed Textile and raw HTML image nodes without parsing images inside inline code', () => {
    const source = [
      '!screen.png(Preview)! and @!literal.png!@',
      '<img alt="Raw &amp; safe" src="/attachments/download/19/raw.png" data-token="keep">',
    ].join('\n');
    const prepared = prepareRedmineSource(source, 'textile');
    expect([...prepared.images.values()]).toEqual([
      { raw: '!screen.png(Preview)!', source: 'screen.png', alt: 'Preview' },
      { raw: '<img alt="Raw &amp; safe" src="/attachments/download/19/raw.png" data-token="keep">', source: '/attachments/download/19/raw.png', alt: 'Raw & safe' },
    ]);
    expect(serializeRedmineSource(prepared.markdown, prepared)).toBe(source);
  });

  it('serializes nested Markdown lists and marked code blocks into Redmine Textile', () => {
    const prepared = prepareRedmineSource('', 'textile');
    const markdown = '## Title\n\n- parent\n  - child\n    - nested\n\n```ruby\nputs "safe < text"\n```\n\n~~~text\n  keep whitespace\n\n~~~';
    const serialized = serializeRedmineSource(markdown, prepared);
    expect(serialized).toContain('h2. Title');
    expect(serialized).toContain('* parent\n** child\n*** nested');
    expect(serialized).toContain('<pre><code class="ruby">\nputs "safe &lt; text"\n</code></pre>');
    expect(serialized).toContain('<pre><code>\n  keep whitespace\n\n</code></pre>');
    expect(serialized).not.toContain('```');
    expect(serialized).not.toContain('~~~');
    expect(serialized.match(/<pre><code/g)).toHaveLength(2);
  });

  it('accepts only safe language tokens for newly serialized Textile code blocks', () => {
    const prepared = prepareRedmineSource('', 'textile');
    const serialized = serializeRedmineSource('```ruby\" onclick=x\n<escaped>\n```', prepared);
    expect(serialized).toContain('<pre><code>\n&lt;escaped&gt;\n</code></pre>');
    expect(serialized).not.toContain('onclick');
  });

  it('renders only explicit Textile code classes as highlighted Markdown fences', () => {
    const explicit = redminePreviewSource('<pre><code class="ruby syntaxhl">\nputs 1\n</code></pre>', 'textile');
    const plain = redminePreviewSource('<pre><code>\nplain\n</code></pre>', 'textile');
    expect(explicit.content).toContain('~~~ruby\nputs 1\n~~~');
    expect(plain.content).toContain('~~~\nplain\n~~~');
    expect(plain.content).not.toContain('~~~ruby');
  });
});
