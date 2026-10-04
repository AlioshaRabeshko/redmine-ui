import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichContent, attachmentContentPath, isPreviewableImage, renderTextileImages, resolveRichImageSource } from './RichContent';
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
      source={'| Feature | State |\n|---|---|\n| Cache | Ready |\n\n```html\n<img src=x onerror="alert(1)">\n```\n\n<script>alert(2)</script>'}
    />);
    expect(html).toContain('<table>');
    expect(html).toContain('class="rich-code-block"');
    expect(html).toContain('language-html');
    expect(html).toContain('&lt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror=');
  });

  it('renders known Textile image tokens as images through the same issue-scoped resolver', () => {
    const html = renderToStaticMarkup(<RichContent source="!screen.png!" issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
    expect(html).toContain(`<img src="${attachmentContentPath(issueId, 314)}"`);
  });

  it('leaves unknown fenced languages as readable code without failing the renderer', () => {
    const html = renderToStaticMarkup(<RichContent source={'```made-up-language\nplain readable text\n```'} issueId={issueId} attachments={attachments} redmineUrl={redmineUrl} />);
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
    const transformed = renderTextileImages(source, issueId, attachments, redmineUrl);
    expect(transformed).toContain(`![screen.png](<${attachmentContentPath(issueId, 314)}>)`);
    expect(transformed).toContain('`!screen.png!`');
    expect(transformed).toContain('```text\n!screen.png!\n```');
  });
});
