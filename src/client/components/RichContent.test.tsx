import { load } from 'cheerio';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichContent, attachmentContentPath, isPreviewableImage, renderTextileImages, resolveRichImageSource } from './RichContent';
import { redminePreviewSource } from './redmineFormatting';
import type { Attachment } from '../../shared/types';

const issueId = 4242;
const redmineUrl = 'https://redmine.example.test';
const attachments: Attachment[] = [
  { id: 314, filename: 'screen.png', url: `${redmineUrl}/attachments/download/314/screen.png`, size: 1200, contentType: 'image/png' },
  { id: 315, filename: 'manual.svg', url: `${redmineUrl}/attachments/download/315/manual.svg`, size: 800, contentType: 'image/svg+xml' },
];

describe('RichContent', () => {
  it('renders fenced Markdown code and GFM without interpreting embedded HTML', () => {
    const html = renderToStaticMarkup(<RichContent
      issueId={issueId} attachments={attachments} redmineUrl={redmineUrl}
      format="common_mark"
      source={'| Feature | State |\n|---|---|\n| Cache | Ready |\n\n```html\n<img src=x onerror="alert(1)">\n```\n\n<script>alert(2)</script>'}
    />);
    expect(html).toContain('<table>');
    expect(html).toContain('class="rich-code-block"');
    expect(html).toContain('language-html');
    expect(html).toContain('&lt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror=');
  });

  it('renders sanitized Redmine CommonMark pre/code and routes raw HTML images through the issue resolver', () => {
    const html = renderToStaticMarkup(<RichContent
      issueId={issueId} attachments={attachments} redmineUrl={redmineUrl}
      format="common_mark"
      source={'<pre><code class="language-ruby attack" onclick="alert(1)">puts 1</code></pre>\n<img src="/attachments/download/314/screen.png" alt="Diagram">'}
    />);
    expect(html).toContain('<pre class="rich-code-block"><code class="hljs language-ruby">');
    expect(html).not.toContain('attack');
    expect(html).not.toContain('onclick=');
    expect(html).toContain('puts <span class="hljs-number">1</span>');
    expect(html).toContain(`<img src="${attachmentContentPath(issueId, 314)}"`);
    expect(html).toContain('alt="Diagram"');
  });

  it('sanitizes raw scripts, frames, event handlers, and unsafe image protocols', () => {
    const html = renderToStaticMarkup(<RichContent
      issueId={issueId} attachments={attachments} redmineUrl={redmineUrl}
      format="common_mark"
      source={'<script>alert("x")</script>\n<iframe src="https://evil.example/">frame text</iframe>\n<img src="javascript:alert(1)" alt="unsafe" onerror="alert(2)">\n<div onclick="alert(3)">Visible</div>'}
    />);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('onclick=');
    expect(html).toContain('frame text');
    expect(html).toContain('Visible');
    expect(html).toContain('unsafe');
  });

  it('rejects a raw HTML image route scoped to another issue', () => {
    const html = renderToStaticMarkup(<RichContent
      issueId={issueId} attachments={attachments} redmineUrl={redmineUrl}
      format="common_mark"
      source={'<img src="/api/issues/999/attachments/314/content" alt="private diagram">'}
    />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/api/issues/999/attachments/314/content');
    expect(html).toContain('private diagram');
  });

  it('keeps markup inside raw code and Redmine macros inert', () => {
    const code = renderToStaticMarkup(<RichContent
      issueId={issueId} attachments={attachments} redmineUrl={redmineUrl}
      format="common_mark"
      source={'<pre><code class="language-html"><img src="/api/issues/4242/attachments/314/content" onerror="alert(1)"></code></pre>'}
    />);
    const macro = renderToStaticMarkup(<RichContent
      issueId={issueId} attachments={attachments} redmineUrl={redmineUrl}
      format="common_mark"
      source={'{{custom_macro(<img src="/api/issues/4242/attachments/314/content" onerror="alert(1)">, **literal**)}}'}
    />);
    expect(code).not.toContain('<img');
    expect(code).toContain('language-html');
    expect(code).toContain('class="hljs-name">img');
    expect(load(code)('.rich-content pre code').text()).toBe('<img src="/api/issues/4242/attachments/314/content" onerror="alert(1)">');
    expect(macro).not.toContain('<img');
    expect(macro).not.toContain('<strong>literal</strong>');
    expect(macro).toContain('{{custom_macro');
  });

  it('does not escape HTML-looking text inside fenced or inline Markdown code', () => {
    const source = '```html\n<pre><div>snippet</div></pre>\n```\n\nLiteral `<pre><b>x</b></pre>` stays inline.';
    const html = renderToStaticMarkup(<RichContent source={source} format="common_mark" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    const $ = load(html);
    expect($('.rich-content pre code').text()).toBe('<pre><div>snippet</div></pre>\n');
    expect($('.rich-content p code').text()).toBe('<pre><b>x</b></pre>');
    expect($('.rich-content pre code div, .rich-content p code b')).toHaveLength(0);
  });

  it('keeps non-code HTML tags inside raw pre as literal text', () => {
    const source = '<pre><div>literal</div><code class="language-html"><b>x</b></code></pre>';
    const html = renderToStaticMarkup(<RichContent source={source} format="common_mark" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    const $ = load(html);
    expect($('.rich-content pre').text()).toBe('<div>literal</div><b>x</b>');
    expect($('.rich-content pre div, .rich-content pre code b')).toHaveLength(0);
  });

  it('renders known Textile image tokens as images through the same issue-scoped resolver', () => {
    const html = renderToStaticMarkup(<RichContent source="!screen.png!" format="textile" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    expect(html).toContain(`<img src="${attachmentContentPath(issueId, 314)}"`);
  });

  it('leaves unknown fenced languages as readable code without failing the renderer', () => {
    const html = renderToStaticMarkup(<RichContent source={'```made-up-language\nplain readable text\n```'} format="markdown" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    expect(html).toContain('class="hljs language-made-up-language"');
    expect(html).toContain('plain readable text');
  });

  it('maps issue attachment ids and filenames through the local issue-scoped route', () => {
    expect(resolveRichImageSource('314', issueId, attachments, redmineUrl)).toBe(attachmentContentPath(issueId, 314));
    expect(resolveRichImageSource('screen.png', issueId, attachments, redmineUrl)).toBe(attachmentContentPath(issueId, 314));
    expect(resolveRichImageSource('/attachments/thumbnail/314/200', issueId, attachments, redmineUrl)).toBe(attachmentContentPath(issueId, 314));
    expect(resolveRichImageSource(attachmentContentPath(issueId, 314), issueId, attachments, redmineUrl)).toBe(attachmentContentPath(issueId, 314));
    expect(resolveRichImageSource(attachmentContentPath(issueId, 777), issueId, attachments, redmineUrl)).toBeUndefined();
    expect(resolveRichImageSource(attachmentContentPath(issueId + 1, 314), issueId, attachments, redmineUrl)).toBeUndefined();
    expect(resolveRichImageSource('/attachments/download/777/unknown.png', issueId, attachments, redmineUrl)).toBeUndefined();
    expect(resolveRichImageSource(`${redmineUrl}/issues/5/secret.png`, issueId, attachments, redmineUrl)).toBeUndefined();
  });

  it('allows direct external HTTPS images but rejects insecure or active image URLs', () => {
    expect(resolveRichImageSource('https://images.example.invalid/card/image.webp?token=fixture', issueId, attachments, redmineUrl)).toBe('https://images.example.invalid/card/image.webp?token=fixture');
    expect(resolveRichImageSource('http://images.example.invalid/image.png', issueId, attachments, redmineUrl)).toBeUndefined();
    expect(resolveRichImageSource('javascript:alert(1)', issueId, attachments, redmineUrl)).toBeUndefined();
    expect(resolveRichImageSource('data:image/svg+xml,<svg/>', issueId, attachments, redmineUrl)).toBeUndefined();
    expect(isPreviewableImage(attachments[0]!)).toBe(true);
    expect(isPreviewableImage(attachments[1]!)).toBe(false);
  });

  it('transforms Textile image tokens without changing fenced or inline code', () => {
    const source = 'Before !screen.png! and `!screen.png!`\n\n```text\n!screen.png!\n```';
    const transformed = renderTextileImages(redminePreviewSource(source, 'textile').content, issueId, attachments, redmineUrl);
    expect(transformed).toContain(`![screen.png](<${attachmentContentPath(issueId, 314)}>)`);
    expect(transformed).toContain('`!screen.png!`');
    expect(transformed).toContain('```text\n!screen.png!\n```');
  });

  it('does not resolve image-looking text inside Redmine macros, inline code, or pre blocks', () => {
    const source = [
      'Outside !screen.png!',
      '@!screen.png!@',
      '{{custom_macro(!screen.png!)}}',
      '<pre><code>!screen.png!</code></pre>',
      '~~~ruby',
      '!screen.png!',
      '~~~',
    ].join('\n');
    const transformed = renderTextileImages(redminePreviewSource(source, 'textile').content, issueId, attachments, redmineUrl);
    expect(transformed).toContain(`![screen.png](<${attachmentContentPath(issueId, 314)}>)`);
    expect(transformed).toContain('`!screen.png!`');
    expect(transformed).toContain('{{custom_macro(!screen.png!)}}');
    expect(transformed).toContain('~~~\n!screen.png!\n~~~');
    expect(transformed).toContain('~~~ruby\n!screen.png!\n~~~');
  });

  it('keeps user text that collides with an internal opaque token', () => {
    const source = 'Literal RICHCONTENTOPAQUE0TOKEN and !screen.png!';
    const transformed = renderTextileImages(source, issueId, attachments, redmineUrl);
    expect(transformed).toContain('Literal RICHCONTENTOPAQUE0TOKEN');
    expect(transformed).toContain(`![screen.png](<${attachmentContentPath(issueId, 314)}>)`);
  });

  it('uses Textile only when the instance declares Textile and renders safe images/code consistently', () => {
    const textile = renderToStaticMarkup(<RichContent
      source={'h2. Заголовок\n\n*жирний* _курсив_\n\n!screen.png!\n\n<pre><code class="ruby">\nputs 1\n</code></pre>'}
      format="textile" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl}
    />);
    expect(textile).toContain('<h2>Заголовок</h2>');
    expect(textile).toContain('<strong>жирний</strong>');
    expect(textile).toContain('<em>курсив</em>');
    expect(textile).toContain(`<img src="${attachmentContentPath(issueId, 314)}"`);
    expect(textile).toContain('language-ruby');
  });

  it('renders Textile extended block quotes while leaving the source syntax unchanged', () => {
    const source = 'bq.. First line\ncontinuation with *strong*';
    const html = renderToStaticMarkup(<RichContent source={source} format="textile" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).not.toContain('&gt; .');
  });

  it('does not guess Markdown when the server has not confirmed a formatter', () => {
    const source = '# raw title\n\n**not interpreted**';
    const html = renderToStaticMarkup(<RichContent source={source} issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    expect(html).toContain('class="rich-source-only"');
    expect(html).toContain('# raw title');
    expect(html).toContain('**not interpreted**');
    expect(html).not.toContain('<h1>');
  });

  it('highlights code only for an explicit language and never guesses from the body', () => {
    const explicit = renderToStaticMarkup(<RichContent source={'```javascript\nconst value = "x";\n```'} format="markdown" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    const plain = renderToStaticMarkup(<RichContent source={'```\nconst value = "x";\n```'} format="markdown" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    expect(explicit).toContain('language-javascript');
    expect(explicit).toContain('hljs-keyword');
    expect(plain).toContain('<code>');
    expect(plain).not.toContain('hljs-keyword');
  });
});
