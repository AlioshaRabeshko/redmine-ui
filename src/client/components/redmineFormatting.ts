import type { Attachment } from '../../shared/types';

export type RedmineTextFormat = 'textile' | 'markdown' | 'common_mark' | 'unsupported';
export interface OpaqueRedmineSource { raw: string; label: string }
export interface RedmineSourceImage { raw: string; source: string; alt: string }
export interface PreparedRedmineSource {
  format: RedmineTextFormat;
  markdown: string;
  opaque: Map<string, OpaqueRedmineSource>;
  images: Map<string, RedmineSourceImage>;
  visualSupported: boolean;
}

export function normalizeRedmineTextFormat(value?: string): RedmineTextFormat {
  const normalized = value?.trim().toLocaleLowerCase().replace(/[ -]/g, '_');
  if (normalized === 'textile') return 'textile';
  if (normalized === 'markdown' || normalized === 'common_mark') return normalized;
  return 'unsupported';
}

function opaqueToken(raw: string, label: string, opaque: Map<string, OpaqueRedmineSource>, original: string): string {
  let index = opaque.size;
  let token = 'RDMOPAQUE' + index + 'END';
  while (original.includes(token) || opaque.has(token)) token = 'RDMOPAQUE' + (++index) + 'END';
  opaque.set(token, { raw, label });
  return token;
}

function protectMatches(source: string, pattern: RegExp, opaque: Map<string, OpaqueRedmineSource>, labelFor: (raw: string) => string): string {
  return source.replace(pattern, (raw) => opaqueToken(raw, labelFor(raw), opaque, source));
}

function imageToken(raw: string, imageSource: string, alt: string, images: Map<string, RedmineSourceImage>, original: string): string {
  let index = images.size;
  let token = 'RDMIMAGE' + index + 'END';
  while (original.includes(token) || images.has(token)) token = 'RDMIMAGE' + (++index) + 'END';
  images.set(token, { raw, source: imageSource, alt });
  return token;
}

function normalizeReferenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function markdownReferenceDestinations(source: string): Map<string, string> {
  const destinations = new Map<string, string>();
  const definition = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<((?:\\.|[^>\n])*)>|((?:\\.|[^\s])+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))*[ \t]*$/gm;
  for (const match of source.matchAll(definition)) {
    const label = match[1] || '';
    if (label.startsWith('^')) continue;
    const destination = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
    if (destination && !destinations.has(normalizeReferenceLabel(label))) destinations.set(normalizeReferenceLabel(label), destination);
  }
  return destinations;
}

function htmlTagEnd(source: string, start: number): number | undefined {
  if (source[start] !== '<') return undefined;
  let quote = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index + 1;
  }
  return undefined;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function htmlImageAttributes(raw: string): { source: string; alt: string } | undefined {
  if (!/^<\s*img\b/i.test(raw)) return undefined;
  const attributes = raw.replace(/^<\s*img\b/i, '').replace(/\/?>\s*$/, '');
  const read = (name: string) => {
    const match = attributes.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s"\\x27=<>]+))', 'i'));
    return match ? decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? '') : undefined;
  };
  const imageSource = read('src');
  return imageSource === undefined ? undefined : { source: imageSource, alt: read('alt') || '' };
}

function markdownImageAt(source: string, start: number, references: Map<string, string>): { end: number; alt: string; source: string } | undefined {
  if (!source.startsWith('![', start)) return undefined;
  let closeAlt = start + 2;
  while (closeAlt < source.length) {
    if (source[closeAlt] === '\\') { closeAlt += 2; continue; }
    if (source[closeAlt] === ']') break;
    closeAlt += 1;
  }
  if (source[closeAlt] !== ']') return undefined;
  const rawAlt = source.slice(start + 2, closeAlt);
  const alt = rawAlt.replace(/\\(.)/g, '$1');
  let cursor = closeAlt + 1;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  if (source[cursor] === '(') {
    cursor += 1;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    let destination = '';
    if (source[cursor] === '<') {
      const destinationStart = ++cursor;
      while (cursor < source.length && source[cursor] !== '>') {
        if (source[cursor] === '\\') cursor += 1;
        cursor += 1;
      }
      if (source[cursor] !== '>') return undefined;
      destination = source.slice(destinationStart, cursor).replace(/\\(.)/g, '$1');
      cursor += 1;
    } else {
      const destinationStart = cursor;
      let depth = 0;
      while (cursor < source.length) {
        const character = source[cursor]!;
        if (character === '\\') { cursor += 2; continue; }
        if (character === '(') { depth += 1; cursor += 1; continue; }
        if (character === ')') {
          if (depth === 0) break;
          depth -= 1;
          cursor += 1;
          continue;
        }
        if (/\s/.test(character) && depth === 0) break;
        cursor += 1;
      }
      destination = source.slice(destinationStart, cursor).replace(/\\(.)/g, '$1');
    }
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === '"' || source[cursor] === "'" || source[cursor] === '(') {
      const quote = source[cursor] === '(' ? ')' : source[cursor]!;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') { cursor += 2; continue; }
        if (source[cursor] === quote) { cursor += 1; break; }
        cursor += 1;
      }
      while (/\s/.test(source[cursor] || '')) cursor += 1;
    }
    if (source[cursor] !== ')' || !destination) return undefined;
    return { end: cursor + 1, alt, source: destination };
  }
  let reference = rawAlt;
  if (source[cursor] === '[') {
    const closeReference = source.indexOf(']', cursor + 1);
    if (closeReference < 0) return undefined;
    reference = source.slice(cursor + 1, closeReference) || rawAlt;
    cursor = closeReference + 1;
  } else if (cursor !== closeAlt + 1) {
    return undefined;
  }
  const destination = references.get(normalizeReferenceLabel(reference));
  return destination ? { end: cursor, alt, source: destination } : undefined;
}

function replaceMarkdownImages(line: string, images: Map<string, RedmineSourceImage>, references: Map<string, string>, original: string): string {
  let output = '';
  for (let cursor = 0; cursor < line.length;) {
    const character = line[cursor]!;
    const tickCode = String.fromCharCode(96);
    if (character === tickCode) {
      let runEnd = cursor + 1;
      while (line[runEnd] === tickCode) runEnd += 1;
      const fence = line.slice(cursor, runEnd);
      const closing = line.indexOf(fence, runEnd);
      const end = closing >= 0 ? closing + fence.length : runEnd;
      output += line.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (line.startsWith('<!--', cursor)) {
      const endComment = line.indexOf('-->', cursor + 4);
      const end = endComment < 0 ? line.length : endComment + 3;
      output += line.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (line.startsWith('{{', cursor)) {
      const endMacro = line.indexOf('}}', cursor + 2);
      if (endMacro >= 0) {
        output += line.slice(cursor, endMacro + 2);
        cursor = endMacro + 2;
        continue;
      }
    }
    if (character === '<' && /^<\s*img\b/i.test(line.slice(cursor))) {
      const end = htmlTagEnd(line, cursor);
      if (end !== undefined) {
        const raw = line.slice(cursor, end);
        const attrs = htmlImageAttributes(raw);
        if (attrs) {
          output += imageToken(raw, attrs.source, attrs.alt, images, original);
          cursor = end;
          continue;
        }
      }
    }
    if (character === '!') {
      const parsed = markdownImageAt(line, cursor, references);
      if (parsed) {
        const raw = line.slice(cursor, parsed.end);
        output += imageToken(raw, parsed.source, parsed.alt, images, original);
        cursor = parsed.end;
        continue;
      }
    }
    output += character;
    cursor += 1;
  }
  return output;
}

function textileImageAt(source: string, start: number): { end: number; alt: string; source: string } | undefined {
  if (source[start] !== '!') return undefined;
  let end = start + 1;
  while (end < source.length && source[end] !== '!' && source[end] !== '\n') {
    if (source[end] === '\\') end += 1;
    end += 1;
  }
  if (source[end] !== '!' || end === start + 1) return undefined;
  const rawValue = source.slice(start + 1, end);
  const value = rawValue.replace(/^\{[^}]*\}/, '');
  const altMatch = value.match(/^(.*)\(([^()]*)\)$/);
  const imageSource = (altMatch?.[1] || value).trim();
  if (!imageSource) return undefined;
  return { end: end + 1, alt: altMatch?.[2] || imageSource.split(/[?#]/, 1)[0]?.split('/').at(-1) || '', source: imageSource };
}

function replaceTextileImages(line: string, images: Map<string, RedmineSourceImage>, original: string): string {
  let output = '';
  for (let cursor = 0; cursor < line.length;) {
    if (line[cursor] === '@') {
      const closing = line.indexOf('@', cursor + 1);
      if (closing >= 0) {
        output += line.slice(cursor, closing + 1);
        cursor = closing + 1;
        continue;
      }
    }
    if (line.startsWith('{{', cursor)) {
      const endMacro = line.indexOf('}}', cursor + 2);
      if (endMacro >= 0) {
        output += line.slice(cursor, endMacro + 2);
        cursor = endMacro + 2;
        continue;
      }
    }
    if (line[cursor] === '<' && /^<\s*img\b/i.test(line.slice(cursor))) {
      const end = htmlTagEnd(line, cursor);
      if (end !== undefined) {
        const raw = line.slice(cursor, end);
        const attrs = htmlImageAttributes(raw);
        if (attrs) {
          output += imageToken(raw, attrs.source, attrs.alt, images, original);
          cursor = end;
          continue;
        }
      }
    }
    if (line[cursor] === '!') {
      const parsed = textileImageAt(line, cursor);
      if (parsed) {
        const raw = line.slice(cursor, parsed.end);
        output += imageToken(raw, parsed.source, parsed.alt, images, original);
        cursor = parsed.end;
        continue;
      }
    }
    output += line[cursor]!;
    cursor += 1;
  }
  return output;
}

function protectCodeFences(lines: string[], index: number, opaque: Map<string, OpaqueRedmineSource>, source: string): { token: string; next: number } | undefined {
  const opening = (lines[index] || '').match(/^\s*(`{3,}|~{3,})/);
  if (!opening) return undefined;
  const fence = opening[1] || '```';
  let end = index + 1;
  while (end < lines.length && !(new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$')).test(lines[end] || '')) end += 1;
  if (end < lines.length) end += 1;
  const raw = lines.slice(index, end).join('\n');
  return { token: opaqueToken(raw, 'Блок коду збережено', opaque, source), next: end };
}

function protectUnsupportedMarkdown(source: string, opaque: Map<string, OpaqueRedmineSource>, images: Map<string, RedmineSourceImage>, protectImages: boolean): string {
  const references = markdownReferenceDestinations(source);
  const protectedSource = protectMatches(source, /\{\{[\s\S]*?\}\}/g, opaque, () => 'Макрос Redmine збережено');
  const lines = protectedSource.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const fenceOpening = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceOpening) {
      const fence = fenceOpening[1] || '```';
      let end = index + 1;
      while (end < lines.length && !(new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$')).test(lines[end] || '')) end += 1;
      if (end < lines.length) end += 1;
      out.push(...lines.slice(index, end));
      index = end;
      continue;
    }
    if (index + 1 < lines.length && /^\s*\|?.+\|.+\|?\s*$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[index + 1] || '')) {
      let end = index + 2;
      while (end < lines.length && /^\s*\|?.+\|.+\|?\s*$/.test(lines[end] || '')) end += 1;
      out.push(opaqueToken(lines.slice(index, end).join('\n'), 'Таблиця Markdown збережена', opaque, source));
      index = end;
      continue;
    }
    if (/^\s*(?:[-*+]\s+\[[ xX]\]|\d+[.)]\s+\[[ xX]\])/.test(line)) {
      let end = index + 1;
      while (end < lines.length && /^\s*(?:[-*+]\s+\[[ xX]\]|\d+[.)]\s+\[[ xX]\])/.test(lines[end] || '')) end += 1;
      out.push(opaqueToken(lines.slice(index, end).join('\n'), 'Список Markdown збережено', opaque, source));
      index = end;
      continue;
    }
    if (/^ {0,3}\[(?:\^[^\]]+|[^\]]+)\]:/.test(line)) {
      let end = index + 1;
      while (end < lines.length && /^(?: {2,}|\t)/.test(lines[end] || '')) end += 1;
      out.push(opaqueToken(lines.slice(index, end).join('\n'), 'Посилання Markdown збережено', opaque, source));
      index = end;
      continue;
    }
    out.push(line);
    index += 1;
  }
  const blockProcessed = out.join('\n');
  const outside: string[] = [];
  const finalLines = blockProcessed.split('\n');
  for (let index = 0; index < finalLines.length;) {
    const opening = (finalLines[index] || '').match(/^\s*(`{3,}|~{3,})/);
    if (opening) {
      const fence = opening[1] || '```';
      let end = index + 1;
      while (end < finalLines.length && !(new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$')).test(finalLines[end] || '')) end += 1;
      if (end < finalLines.length) end += 1;
      outside.push(...finalLines.slice(index, end));
      index = end;
      continue;
    }
    if (/^\s*<(script|style|iframe|object)\b/i.test(finalLines[index] || '')) {
      let end = index + 1;
      const tag = (finalLines[index] || '').match(/^\s*<(script|style|iframe|object)\b/i)?.[1] || 'script';
      while (end < finalLines.length && !new RegExp('</' + tag + '\\s*>', 'i').test(finalLines[end] || '')) end += 1;
      if (end < finalLines.length) end += 1;
      const raw = finalLines.slice(index, end).join('\n');
      outside.push(opaqueToken(raw, 'HTML-фрагмент збережено', opaque, source));
      index = end;
      continue;
    }
    let line = finalLines[index] || '';
    if (protectImages) line = replaceMarkdownImages(line, images, references, source);
    line = line.replace(/<\/?[a-z][^>]*>/gi, (raw) => opaqueToken(raw, raw, opaque, source));
    line = line.replace(/!\[[^\]]*\]\[[^\]]*\]|(?<!\!)\[[^\]]+\]\[[^\]]*\]|\[\^[^\]]+\]/g, (raw) => opaqueToken(raw, 'Посилання Markdown збережено', opaque, source));
    outside.push(line);
    index += 1;
  }
  return outside.join('\n');
}

function protectUnsupportedTextile(source: string, opaque: Map<string, OpaqueRedmineSource>, images: Map<string, RedmineSourceImage>, protectImages: boolean, protectCodeBlocks: boolean): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length;) {
    const fence = protectCodeBlocks ? protectCodeFences(lines, index, opaque, source) : undefined;
    if (fence) { out.push(fence.token); index = fence.next; continue; }
    const line = lines[index] || '';
    const rawHtmlCode = line.match(/^\s*<pre\b/i);
    if (protectCodeBlocks && rawHtmlCode) {
      let end = index + 1;
      while (end < lines.length && !/<\/pre\s*>/i.test(lines[end] || '')) end += 1;
      if (end < lines.length) end += 1;
      out.push(opaqueToken(lines.slice(index, end).join('\n'), 'Блок коду збережено', opaque, source));
      index = end;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      let end = index + 1;
      while (end < lines.length && /^\s*\|.*\|\s*$/.test(lines[end] || '')) end += 1;
      out.push(opaqueToken(lines.slice(index, end).join('\n'), 'Таблиця Textile збережена', opaque, source));
      index = end;
      continue;
    }
    if (protectCodeBlocks && /^\s*(?:bc|pre)\.\s*/.test(line)) {
      let end = index + 1;
      while (end < lines.length && lines[end]?.trim()) end += 1;
      out.push(opaqueToken(lines.slice(index, end).join('\n'), 'Блок Textile збережено', opaque, source));
      index = end;
      continue;
    }
    if (/^ {0,3}bq\.\./.test(line)) {
      let end = index + 1;
      while (end < lines.length && lines[end]?.trim()) end += 1;
      out.push(opaqueToken(lines.slice(index, end).join('\n'), 'Розширену цитату Textile збережено', opaque, source));
      index = end;
      continue;
    }
    if (/^\s*notextile\.\s*/.test(line)) {
      let end = index + 1;
      while (end < lines.length && lines[end]?.trim()) end += 1;
      out.push(opaqueToken(lines.slice(index, end).join('\n'), 'Блок Textile збережено', opaque, source));
      index = end;
      continue;
    }
    out.push(line);
    index += 1;
  }
  let result = out.join('\n');
  result = protectMatches(result, /\{\{[\s\S]*?\}\}/g, opaque, () => 'Макрос Redmine збережено');
  if (protectImages) result = result.split('\n').map((line) => replaceTextileImages(line, images, source)).join('\n');
  result = protectMatches(result, /<\/?[a-z][^>]*>/gi, opaque, (raw) => raw);
  return result;
}

const tick = String.fromCharCode(96);
function textileInlineToMarkdown(line: string): string {
  const codeSpans: string[] = [];
  const strongSpans: string[] = [];
  let result = line.replace(/@([^@\n]+)@/g, (_all, content: string) => {
    const token = 'RDMINLINECODE' + codeSpans.length + 'END';
    codeSpans.push(tick + content.replaceAll(tick, '') + tick);
    return token;
  });
  const codeSplit = new RegExp('(' + tick + '+[^' + tick + ']*' + tick + '+)', 'g');
  result = result.split(codeSplit).map((part, index) => {
    if (index % 2) return part;
    let plain = part.replace(/"([^"\n]+)":([^\s]+(?:\([^)]*\))?)/g, '[$1](<$2>)');
    plain = plain.replace(/(^|\s)\*([^*\s][^*]*?)\*(?=$|\s|[.,!?;:)])/g, (_all, prefix: string, content: string) => {
      const token = 'RDMSTRONG' + strongSpans.length + 'END';
      strongSpans.push('**' + content + '**');
      return prefix + token;
    });
    return plain
      .replace(/(^|\s)_([^_\s][^_]*?)_(?=$|\s|[.,!?;:)])/g, '$1*$2*')
      .replace(/(^|\s)-([^\-\s][^\-]*?)-(?=$|\s|[.,!?;:)])/g, '$1~~$2~~');
  }).join('');
  for (let index = 0; index < codeSpans.length; index += 1) result = result.replace('RDMINLINECODE' + index + 'END', codeSpans[index] || '');
  for (let index = 0; index < strongSpans.length; index += 1) result = result.replace('RDMSTRONG' + index + 'END', strongSpans[index] || '');
  return result;
}

function decodeCodeEntities(value: string): string {
  return value.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}

function textileCodeToMarkdown(source: string): string {
  return source.replace(/<pre\b[^>]*>\s*<code(?:\s+class=["']([^"']+)["'])?\s*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_all, className: string | undefined, body: string) => {
    const langClass = className?.split(/\s+/).find((token) => /^(?:language-)?[a-z0-9_+-]+$/i.test(token) && token !== 'syntaxhl');
    const language = langClass?.replace(/^language-/i, '') || '';
    const code = decodeCodeEntities(body).replace(/^\n|\n$/g, '');
    return '~~~' + language + '\n' + code + '\n~~~';
  });
}

function markdownFencesToTextile(source: string, prepared: PreparedRedmineSource): string {
  const lines = source.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const opening = (lines[index] || '').match(/^( {0,3})(`{3,}|~{3,})([^\n]*)$/);
    if (!opening) { output.push(lines[index] || ''); index += 1; continue; }
    const indent = opening[1] || '';
    const marker = opening[2] || '```';
    const info = (opening[3] || '').trim();
    if (marker[0] === '`' && info.includes('`')) { output.push(lines[index] || ''); index += 1; continue; }
    const closePattern = new RegExp('^ {0,3}' + (marker[0] === '`' ? '`' : '~') + '{' + marker.length + ',}[ \\t]*$');
    let end = index + 1;
    while (end < lines.length && !closePattern.test(lines[end] || '')) end += 1;
    if (end >= lines.length) { output.push(lines[index] || ''); index += 1; continue; }
    const code = lines.slice(index + 1, end).join('\n');
    const candidate = info.split(/\s+/, 1)[0]?.replace(/^language-/i, '') || '';
    const safeLanguage = /^[a-zA-Z0-9_+-]+$/.test(candidate) && candidate !== 'text' ? candidate : '';
    const classAttribute = safeLanguage ? ' class="' + safeLanguage + '"' : '';
    const safeCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const raw = '<pre><code' + classAttribute + '>\n' + safeCode + '\n</code></pre>';
    output.push(indent + opaqueToken(raw, 'Блок коду Redmine', prepared.opaque, source));
    index = end + 1;
  }
  return output.join('\n');
}

function textileExtendedBlockquoteToMarkdown(source: string): string {
  return source.split('\n').map((line, index) => {
    const content = index === 0 ? line.replace(/^ {0,3}bq\.\./, '').replace(/^\s+/, '') : line;
    return '> ' + textileInlineToMarkdown(content);
  }).join('\n');
}

function textileToMarkdown(source: string, protectCodeBlocks: boolean): string {
  const lines = source.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    if (!protectCodeBlocks && /^\s*bc\.\s*/.test(line)) {
      const code = [line.replace(/^\s*bc\.\s*/, '')];
      let end = index + 1;
      while (end < lines.length && lines[end]?.trim()) code.push(lines[end++] || '');
      output.push('~~~');
      output.push(...code);
      output.push('~~~');
      index = end;
      continue;
    }
    let match = line.match(/^h([1-6])\.\s+(.*)$/);
    if (match) { output.push('#'.repeat(Number(match[1])) + ' ' + textileInlineToMarkdown(match[2] || '')); index += 1; continue; }
    match = line.match(/^bq\.(?!\.)\s?(.*)$/);
    if (match) { output.push('> ' + textileInlineToMarkdown(match[1] || '')); index += 1; continue; }
    match = line.match(/^p\.\s+(.*)$/);
    if (match) { output.push(textileInlineToMarkdown(match[1] || '')); index += 1; continue; }
    match = line.match(/^(\*+|#+)\s+(.*)$/);
    if (match) {
      const depth = (match[1] || '').length;
      const content = textileInlineToMarkdown(match[2] || '');
      output.push('  '.repeat(depth - 1) + (match[1]?.[0] === '*' ? '- ' : '1. ') + content);
      index += 1;
      continue;
    }
    if (/^\s*---\s*$/.test(line)) output.push('***');
    else output.push(textileInlineToMarkdown(line));
    index += 1;
  }
  return output.join('\n');
}

export function prepareRedmineSource(source: string, rawFormat?: string, options: { protectImages?: boolean; protectCodeBlocks?: boolean } = {}): PreparedRedmineSource {
  const format = normalizeRedmineTextFormat(rawFormat);
  const opaque = new Map<string, OpaqueRedmineSource>();
  const images = new Map<string, RedmineSourceImage>();
  if (format === 'unsupported') return { format, markdown: source, opaque, images, visualSupported: false };
  const protectImages = options.protectImages ?? true;
  const protectCodeBlocks = options.protectCodeBlocks ?? true;
  const preserved = format === 'textile'
    ? protectUnsupportedTextile(source, opaque, images, protectImages, protectCodeBlocks)
    : protectUnsupportedMarkdown(source, opaque, images, protectImages);
  const markdown = format === 'textile' ? textileToMarkdown(preserved, protectCodeBlocks) : preserved;
  return { format, markdown, opaque, images, visualSupported: true };
}

function markdownInlineToTextile(value: string): string {
  const codeSpans: string[] = [];
  const boldSpans: string[] = [];
  let result = value.replace(/\x60([^\x60]+)\x60/g, (_all, code: string) => {
    const token = 'RDMREVCODE' + codeSpans.length + 'END';
    codeSpans.push('@' + code + '@');
    return token;
  });
  result = result
    .replace(/\*\*([^*]+)\*\*/g, (_all, text: string) => {
      const token = 'RDMREVBOLD' + boldSpans.length + 'END';
      boldSpans.push('*' + text + '*');
      return token;
    })
    .replace(/~~([^~]+)~~/g, '-$1-')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '_$1_')
    .replace(/\[([^\]]+)\]\(<([^>]+)>\)/g, '"$1":$2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '"$1":$2');
  for (let index = 0; index < codeSpans.length; index += 1) result = result.replace('RDMREVCODE' + index + 'END', codeSpans[index] || '');
  for (let index = 0; index < boldSpans.length; index += 1) result = result.replace('RDMREVBOLD' + index + 'END', boldSpans[index] || '');
  return result;
}

export function serializeRedmineSource(markdown: string, prepared: PreparedRedmineSource): string {
  if (!prepared.visualSupported) return markdown;
  let source = markdown;
  if (prepared.format === 'textile') {
    source = markdownFencesToTextile(source, prepared);
    source = source.split('\n').map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) return 'h' + heading[1]!.length + '. ' + markdownInlineToTextile(heading[2] || '');
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) return 'bq. ' + markdownInlineToTextile(quote[1] || '');
      const list = line.match(/^(\s*)([-*+]\s+|\d+[.)]\s+)(.*)$/);
      if (list) {
        const marker = list[2]?.trim().startsWith('-') || list[2]?.trim().startsWith('*') ? '*' : '#';
        const depth = Math.max(1, Math.floor((list[1]?.length || 0) / 2) + 1);
        return marker.repeat(depth) + ' ' + markdownInlineToTextile(list[3] || '');
      }
      if (/^\*{3,}$/.test(line.trim())) return '---';
      return markdownInlineToTextile(line);
    }).join('\n');
  }
  for (const [marker, item] of prepared.opaque) source = source.split(marker).join(item.raw);
  for (const [marker, item] of prepared.images) source = source.split(marker).join(item.raw);
  return source;
}

export function redminePreviewSource(source: string, rawFormat?: string): { format: RedmineTextFormat; content: string; visualSupported: boolean } {
  const format = normalizeRedmineTextFormat(rawFormat);
  const previewInput = format === 'textile' ? textileCodeToMarkdown(source) : source;
  const prepared = prepareRedmineSource(previewInput, rawFormat, { protectImages: false, protectCodeBlocks: format !== 'textile' });
  if (!prepared.visualSupported) return { format: prepared.format, content: source, visualSupported: false };
  let content = prepared.markdown;
  for (const [marker, item] of prepared.opaque) {
    const display = prepared.format === 'textile' && /^ {0,3}bq\.\./.test(item.raw)
      ? textileExtendedBlockquoteToMarkdown(item.raw)
      : item.raw;
    content = content.split(marker).join(display);
  }
  return { format: prepared.format, content, visualSupported: true };
}
