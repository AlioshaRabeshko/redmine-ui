import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Attachment } from '../../shared/types';
import './RichContent.css';

const safeImageTypes = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const safeImageExtensions = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);

export interface RichContentProps {
  source: string;
  issueId: number;
  attachments: Attachment[];
  redmineUrl: string;
  className?: string;
  imageUnavailableText?: string;
  openOriginalText?: string;
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
  let inFence = false;
  return source.split('\n').map((line) => {
    const fence = line.match(/^ {0,3}(`{3,})/);
    if (fence) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
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

function SafeMarkdownImage({ src, alt, redmineUrl, issueId, attachments, unavailableText, openOriginalText }: {
  src?: string; alt?: string; redmineUrl: string; issueId: number; attachments: Attachment[]; unavailableText: string; openOriginalText: string;
}) {
  const [failed, setFailed] = useState(false);
  const safeSrc = src ? resolveRichImageSource(src, issueId, attachments, redmineUrl) : undefined;
  if (!safeSrc) return <span className="rich-image-unavailable">{alt || unavailableText}</span>;
  if (failed) return <span className="rich-image-failed"><span>{unavailableText}{alt ? `: ${alt}` : ''}</span><a href={safeSrc} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">{openOriginalText}</a></span>;
  return <a className="rich-image-link" href={safeSrc} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" aria-label={`${openOriginalText}: ${alt || unavailableText}`}>
    <img src={safeSrc} alt={alt || unavailableText} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  </a>;
}

export function RichContent({ source, issueId, attachments, redmineUrl, className = '', imageUnavailableText = 'Image unavailable', openOriginalText = 'Open original' }: RichContentProps) {
  const content = renderTextileImages(source, issueId, attachments, redmineUrl);
  const components: Components = {
    img: (props) => <SafeMarkdownImage src={props.src} alt={props.alt} redmineUrl={redmineUrl} issueId={issueId} attachments={attachments}
      unavailableText={imageUnavailableText} openOriginalText={openOriginalText} />,
    a: ({ href, children, node, ...props }) => {
      void node;
      const safeHref = safeMarkdownHref(href, redmineUrl);
      return safeHref ? <a {...props} href={safeHref} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>;
    },
    pre: ({ children, node, ...props }) => { void node; return <pre {...props} className="rich-code-block">{children}</pre>; },
  };
  return <div className={`rich-content ${className}`.trim()} data-testid="rich-content">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]} components={components} skipHtml>{content}</ReactMarkdown>
  </div>;
}

export function AttachmentPreview({ attachment, issueId, unavailableText, openOriginalText }: {
  attachment: Attachment; issueId: number; unavailableText: string; openOriginalText: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!isPreviewableImage(attachment)) return null;
  const src = attachmentContentPath(issueId, attachment.id);
  return <div className="attachment-preview">
    {failed ? <span className="rich-image-unavailable">{unavailableText}: {attachment.filename}</span>
      : <a className="attachment-preview-image" href={src} target="_blank" rel="noreferrer" aria-label={`${openOriginalText}: ${attachment.filename}`}>
        <img src={src} alt={attachment.filename} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </a>}
    <a href={src} target="_blank" rel="noreferrer" className="attachment-preview-original">{openOriginalText}</a>
  </div>;
}
