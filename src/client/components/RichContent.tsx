import { useEffect, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import type { Attachment } from '../../shared/types';
import { redminePreviewSource } from './redmineFormatting';
import './RichContent.css';
import './formatted-prose.css';

const safeImageTypes = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const safeImageExtensions = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);
const redminePreviewElements = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'input', 'li', 'ol', 'p', 'pre', 'section', 'strong', 'sup',
  'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

// Keep the Markdown elements emitted by CommonMark/GFM, plus the small raw
// HTML subset Redmine sanitizes for issue content. In particular, user HTML
// cannot introduce containers, embeds, SVG, forms, styles, or event handlers.
const redmineCommonMarkSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames || []).filter((tag) => redminePreviewElements.has(tag)),
  attributes: {
    ...defaultSchema.attributes,
    // Match Redmine's language marker form while rejecting arbitrary classes.
    code: [['className', /^language-\S+$/]],
    // Image URLs are re-checked by resolveRichImageSource before a request.
    img: ['src', 'alt', 'title'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
};

function markdownCodeSpan(source: string): string {
  const runs = [...source.matchAll(/`+/g)].map((match) => match[0].length);
  const fence = '`'.repeat(Math.max(0, ...runs) + 1);
  const needsPadding = (source.startsWith(' ') && source.endsWith(' ') && source.trim().length > 0)
    || source.startsWith('`') || source.endsWith('`');
  return fence + (needsPadding ? ` ${source} ` : source) + fence;
}

interface HtmlTagToken {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

function htmlTagAt(source: string, start: number): HtmlTagToken | undefined {
  if (source[start] !== '<') return undefined;
  let quote = '';
  let end = start + 1;
  for (; end < source.length; end += 1) {
    const character = source[end]!;
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') break;
  }
  if (end >= source.length) return undefined;
  const raw = source.slice(start, end + 1);
  const match = raw.match(/^<\s*(\/?)\s*([a-z][\w:-]*)\b[\s\S]*>$/i);
  if (!match) return undefined;
  return {
    name: match[2]!.toLowerCase(),
    closing: Boolean(match[1]),
    selfClosing: /\/\s*>$/.test(raw),
    end: end + 1,
  };
}

function matchingCodeElementEnd(source: string, openingEnd: number, name: 'pre' | 'code'): { start: number; end: number } | undefined {
  let depth = 1;
  let cursor = openingEnd;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) return undefined;
    const tag = htmlTagAt(source, start);
    if (!tag) { cursor = start + 1; continue; }
    if (tag.name === name) {
      if (tag.closing) depth -= 1;
      else if (!tag.selfClosing) depth += 1;
      if (depth === 0) return { start, end: tag.end };
    }
    cursor = tag.end;
  }
  return undefined;
}

function escapeCodeAngles(source: string): string {
  return source.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRawCodeElement(source: string, name: 'pre' | 'code', openingEnd: number, closing?: { start: number; end: number }): string {
  const end = closing?.start ?? source.length;
  const inner = source.slice(openingEnd, end);
  if (name === 'pre') {
    // Redmine's usual language form is <pre><code class="language-x">…</code></pre>.
    // Preserve just that structural wrapper; treat every other tag inside pre as code text.
    let cursor = 0;
    while (cursor < inner.length) {
      const start = inner.indexOf('<', cursor);
      if (start < 0) break;
      const tag = htmlTagAt(inner, start);
      if (!tag) { cursor = start + 1; continue; }
      if (tag.name === 'code' && !tag.closing && !tag.selfClosing) {
        const codeClose = matchingCodeElementEnd(inner, tag.end, 'code');
        if (codeClose) {
          return escapeCodeAngles(inner.slice(0, start))
            + inner.slice(start, tag.end)
            + escapeCodeAngles(inner.slice(tag.end, codeClose.start))
            + inner.slice(codeClose.start, codeClose.end)
            + escapeCodeAngles(inner.slice(codeClose.end));
        }
      }
      cursor = tag.end;
    }
  }
  return escapeCodeAngles(inner);
}

function markdownFenceEnd(source: string, start: number): number | undefined {
  if (start !== 0 && source[start - 1] !== '\n') return undefined;
  const lineEnd = source.indexOf('\n', start);
  const openingLineEnd = lineEnd < 0 ? source.length : lineEnd;
  const openingLine = source.slice(start, openingLineEnd).replace(/\r$/, '');
  const opening = openingLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!opening || (opening[1]![0] === '`' && opening[2]!.includes('`'))) return undefined;
  const marker = opening[1]!;
  const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[\\t ]*$`);
  let cursor = lineEnd < 0 ? source.length : lineEnd + 1;
  while (cursor < source.length) {
    const nextLineEnd = source.indexOf('\n', cursor);
    const end = nextLineEnd < 0 ? source.length : nextLineEnd;
    if (close.test(source.slice(cursor, end).replace(/\r$/, ''))) return nextLineEnd < 0 ? end : end + 1;
    if (nextLineEnd < 0) break;
    cursor = nextLineEnd + 1;
  }
  return source.length;
}

function inlineCodeEnd(source: string, start: number): number | undefined {
  const opening = source.slice(start).match(/^`+/)?.[0];
  if (!opening) return undefined;
  let cursor = start + opening.length;
  while (cursor < source.length) {
    const candidate = source.indexOf('`', cursor);
    if (candidate < 0) return undefined;
    const run = source.slice(candidate).match(/^`+/)?.[0] || '';
    if (run.length === opening.length) return candidate + run.length;
    cursor = candidate + run.length;
  }
  return undefined;
}

/** Keep macros literal and only escape raw HTML code outside Markdown code spans/blocks. */
function prepareRichContent(source: string): string {
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const fenceEnd = markdownFenceEnd(source, cursor);
    if (fenceEnd !== undefined) {
      output += source.slice(cursor, fenceEnd);
      cursor = fenceEnd;
      continue;
    }

    if (source[cursor] === '`') {
      const end = inlineCodeEnd(source, cursor);
      if (end !== undefined) {
        output += source.slice(cursor, end);
        cursor = end;
        continue;
      }
    }

    if (source.startsWith('<!--', cursor)) {
      const commentEnd = source.indexOf('-->', cursor + 4);
      const end = commentEnd < 0 ? source.length : commentEnd + 3;
      output += source.slice(cursor, end);
      cursor = end;
      continue;
    }

    if (source.startsWith('{{', cursor)) {
      const end = source.indexOf('}}', cursor + 2);
      if (end >= 0) {
        output += markdownCodeSpan(source.slice(cursor, end + 2));
        cursor = end + 2;
        continue;
      }
    }

    const tag = htmlTagAt(source, cursor);
    if (tag && (tag.name === 'pre' || tag.name === 'code') && !tag.closing && !tag.selfClosing) {
      const name = tag.name as 'pre' | 'code';
      const closing = matchingCodeElementEnd(source, tag.end, name);
      output += source.slice(cursor, tag.end)
        + escapeRawCodeElement(source, name, tag.end, closing)
        + (closing ? source.slice(closing.start, closing.end) : '');
      cursor = closing?.end ?? source.length;
      continue;
    }

    if (source[cursor] === '<') {
      output += source[cursor];
      cursor += 1;
      continue;
    }
    output += source[cursor];
    cursor += 1;
  }
  return output;
}

export interface RichContentProps {
  source: string;
  issueId: number;
  attachments: Attachment[];
  redmineUrl: string;
  format?: string;
  className?: string;
  imageUnavailableText?: string;
  openOriginalText?: string;
  retryImageText?: string;
}

export function attachmentContentPath(issueId: number, attachmentId: number): string {
  return `/api/issues/${issueId}/attachments/${attachmentId}/content`;
}

export function isPreviewableImage(attachment: Attachment): boolean {
  const type = attachment.contentType?.split(';', 1)[0]?.trim().toLocaleLowerCase();
  if (type) return safeImageTypes.has(type);
  const extension = attachment.filename.split('.').at(-1)?.toLocaleLowerCase();
  return Boolean(extension && safeImageExtensions.has(extension));
}

/** Resolve only known attachments on this issue; external HTTPS images stay in the browser. */
export function resolveRichImageSource(
  source: string,
  issueId: number,
  attachments: Attachment[],
  redmineUrl: string,
): string | undefined {
  let localProxy: RegExpMatchArray | null = source.match(/^\/api\/issues\/(\d+)\/attachments\/(\d+)\/content(?:[?#].*)?$/);
  if (!localProxy && typeof window !== 'undefined') {
    try {
      const localUrl = new URL(source, window.location.origin);
      if (localUrl.origin === window.location.origin) localProxy = localUrl.pathname.match(/^\/api\/issues\/(\d+)\/attachments\/(\d+)\/content$/);
    } catch { /* Invalid local routes remain unavailable. */ }
  }
  if (localProxy) {
    if (localProxy[1] !== String(issueId)) return undefined;
    const attachment = attachments.find((item) => String(item.id) === localProxy[2]);
    if (attachment && isPreviewableImage(attachment)) return attachmentContentPath(issueId, attachment.id);
    return undefined;
  }
  if (/^\/api\/issues\/\d+\/attachments\//.test(source)) return undefined;
  const attachment = findIssueAttachment(source, attachments, redmineUrl);
  if (attachment) return isPreviewableImage(attachment) ? attachmentContentPath(issueId, attachment.id) : undefined;
  try {
    const base = new URL(redmineUrl);
    const url = new URL(source, `${base.toString().replace(/\/+$/, '')}/`);
    if (url.protocol !== 'https:' || url.username || url.password || url.origin === base.origin) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function findIssueAttachment(source: string, attachments: Attachment[], redmineUrl: string): Attachment | undefined {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  const numericId = attachments.find((attachment) => String(attachment.id) === trimmed);
  if (numericId) return numericId;
  const bareName = attachments.find((attachment) => trimmed === attachment.filename);
  if (bareName) return bareName;
  try {
    const base = new URL(redmineUrl);
    const url = new URL(trimmed, `${base.toString().replace(/\/+$/, '')}/`);
    const isRedmineUrl = url.origin === base.origin;
    if (!isRedmineUrl) return attachments.find((attachment) => {
      try {
        const known = new URL(attachment.url, base);
        return known.href === url.href;
      } catch { return false; }
    });
    const id = url.pathname.match(/\/attachments\/(?:download|thumbnail)\/(\d+)(?:\/|$)/i)?.[1]
      ?? url.pathname.match(/\/attachments\/(\d+)(?:\/|$)/i)?.[1];
    if (id) {
      const known = attachments.find((attachment) => String(attachment.id) === id);
      if (known) return known;
    }
    const pathName = decodeURIComponent(url.pathname.split('/').at(-1) || '').toLocaleLowerCase();
    return attachments.find((attachment) => {
      if (pathName === attachment.filename.toLocaleLowerCase()) return true;
      try { return new URL(attachment.url, base).href === url.href; } catch { return false; }
    });
  } catch {
    return undefined;
  }
}

/** Translate the small legacy Textile image form without altering the saved source. */
export function renderTextileImages(source: string, issueId: number, attachments: Attachment[], redmineUrl: string): string {
  const preserved = new Map<string, string>();
  const protect = (raw: string) => {
    let index = preserved.size;
    let token = `RICHCONTENTOPAQUE${index}TOKEN`;
    while (source.includes(token) || preserved.has(token)) token = `RICHCONTENTOPAQUE${++index}TOKEN`;
    preserved.set(token, raw);
    return token;
  };
  // Redmine macros and preformatted HTML must remain opaque while image
  // references are resolved; a macro may contain syntax that looks like an image.
  let result = source
    .replace(/\{\{[\s\S]*?\}\}/g, protect)
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi, protect);
  let fence: { character: string; length: number } | undefined;
  result = result.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      const opening = marker[1] || '```';
      if (!fence) fence = { character: opening[0]!, length: opening.length };
      else if (opening[0] === fence.character && opening.length >= fence.length && !line.slice(marker[0].length).trim()) fence = undefined;
      return line;
    }
    if (fence) return line;
    return line.split(/(`+[^`\n]*`+)/g).map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/!([^!\n]+)!/g, (match, reference: string) => {
        const cleaned = reference.trim();
        const src = resolveRichImageSource(cleaned, issueId, attachments, redmineUrl);
        if (!src) return match;
        const matching = findIssueAttachment(cleaned, attachments, redmineUrl);
        const alt = matching?.filename || cleaned.split('/').at(-1) || 'Image';
        return `![${alt.replace(/[\[\]]/g, '')}](<${src.replace(/[<>]/g, '')}>)`;
      });
    }).join('');
  }).join('\n');
  for (const [token, raw] of preserved) result = result.split(token).join(raw);
  return result;
}

function safeMarkdownHref(value: string | undefined, redmineUrl: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('#')) return value;
  if (/^mailto:/i.test(value)) return value;
  try {
    const base = new URL(redmineUrl);
    const target = new URL(value, `${base.toString().replace(/\/+$/, '')}/`);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) return undefined;
    return target.toString();
  } catch { return undefined; }
}

export function SafeRichImage({ src, alt, redmineUrl, issueId, attachments, unavailableText, openOriginalText, retryText, loadingText, linkImage = true }: {
  src?: string; alt?: string; redmineUrl: string; issueId: number; attachments: Attachment[]; unavailableText: string; openOriginalText: string; retryText: string;
  loadingText?: string; linkImage?: boolean;
}) {
  const [failedIdentity, setFailedIdentity] = useState<string>();
  const [loadedIdentity, setLoadedIdentity] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const safeSrc = src ? resolveRichImageSource(src, issueId, attachments, redmineUrl) : undefined;
  useEffect(() => {
    setFailedIdentity(undefined);
    setLoadedIdentity(undefined);
    setRetryKey(0);
  }, [safeSrc]);
  if (!safeSrc) return <span className="rich-image-unavailable">{alt || unavailableText}</span>;
  const identity = safeSrc + '\u0000' + retryKey;
  if (failedIdentity === identity) return <span className="rich-image-failed"><span>{unavailableText}{alt ? ': ' + alt : ''}</span><button type="button" onClick={() => setRetryKey((current) => current + 1)}>{retryText}</button><a href={safeSrc} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">{openOriginalText}</a></span>;
  const image = <img key={identity} src={safeSrc} alt={alt || unavailableText} loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onLoad={() => setLoadedIdentity(identity)} onError={() => setFailedIdentity(identity)} />;
  const content = <>{loadedIdentity !== identity && loadingText && <span className="rich-image-loading" role="status">{loadingText}</span>}{image}</>;
  return linkImage
    ? <a className="rich-image-link" href={safeSrc} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" aria-label={openOriginalText + ': ' + (alt || unavailableText)}
      aria-busy={loadedIdentity !== identity} data-image-state={loadedIdentity === identity ? 'loaded' : 'loading'}>{content}</a>
    : <span className="rich-image-link" aria-label={alt || unavailableText} aria-busy={loadedIdentity !== identity}
      data-image-state={loadedIdentity === identity ? 'loaded' : 'loading'}>{content}</span>;
}

export function RichContent({ source, issueId, attachments, redmineUrl, format, className = '', imageUnavailableText = 'Image unavailable', openOriginalText = 'Open original', retryImageText = 'Retry' }: RichContentProps) {
  const prepared = redminePreviewSource(source, format);
  const withImages = prepared.format === 'textile'
    ? renderTextileImages(prepared.content, issueId, attachments, redmineUrl)
    : prepared.content;
  const content = prepareRichContent(withImages);
  const components: Components = {
    img: (props) => <SafeRichImage src={props.src} alt={props.alt} redmineUrl={redmineUrl} issueId={issueId} attachments={attachments}
      unavailableText={imageUnavailableText} openOriginalText={openOriginalText} retryText={retryImageText} />,
    a: ({ href, children, node, ...props }) => {
      void node;
      const safeHref = safeMarkdownHref(href, redmineUrl);
      return safeHref ? <a {...props} href={safeHref} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>;
    },
    pre: ({ children, node, ...props }) => { void node; return <pre {...props} className="rich-code-block">{children}</pre>; },
  };
  return <div className={`rich-content formatted-prose ${className}`.trim()} data-testid="rich-content" data-format={prepared.format}>
    {prepared.visualSupported
      ? <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ allowDangerousHtml: true }}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, redmineCommonMarkSchema], [rehypeHighlight, { detect: false }]]}
        components={components}
      >{content}</ReactMarkdown>
      : <pre className="rich-source-only">{source}</pre>}
  </div>;
}

export function AttachmentPreview({ attachment, issueId, unavailableText, openOriginalText, retryText = 'Retry' }: {
  attachment: Attachment; issueId: number; unavailableText: string; openOriginalText: string; retryText?: string;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const previewable = isPreviewableImage(attachment);
  const src = attachmentContentPath(issueId, attachment.id);
  useEffect(() => { setFailedSource(undefined); setRetryKey(0); }, [src]);
  if (!previewable) return null;
  const failed = failedSource === src;
  return <div className="attachment-preview">
    {failed ? <span className="rich-image-failed"><span>{unavailableText}: {attachment.filename}</span><button type="button" onClick={() => { setFailedSource(undefined); setRetryKey((current) => current + 1); }}>{retryText}</button></span>
      : <a className="attachment-preview-image" href={src} target="_blank" rel="noreferrer" aria-label={`${openOriginalText}: ${attachment.filename}`}>
        <img key={`${src}:${retryKey}`} src={src} alt={attachment.filename} loading="lazy" decoding="async" onError={() => setFailedSource(src)} />
      </a>}
    <a href={src} target="_blank" rel="noreferrer" className="attachment-preview-original">{openOriginalText}</a>
  </div>;
}
