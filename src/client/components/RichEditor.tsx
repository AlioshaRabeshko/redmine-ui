import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react';
import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Bold, Code, CodeXml, Heading2, Italic, Link2, List, ListOrdered, Quote, Strikethrough } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Attachment, Person } from '../../shared/types';
import { SafeRichImage } from './RichContent';
import { normalizeRedmineTextFormat, prepareRedmineSource, serializeRedmineSource, type OpaqueRedmineSource, type PreparedRedmineSource, type RedmineSourceImage } from './redmineFormatting';
import './RichEditor.css';
import './formatted-prose.css';

type MentionPopup = { query: string; from: number; to: number; left: number; top: number };
type MentionChoice = { token: string; name: string; id: number };

function PreservedSourceView({ node }: NodeViewProps) {
  const { t } = useTranslation();
  const raw = String(node.attrs.raw || '');
  return <NodeViewWrapper as="span" className="redmine-preserved-token" contentEditable={false} title={raw} data-preserved-source="true">
    <code>{t('preservedMarkup')}</code>
  </NodeViewWrapper>;
}

function createPreservedNode(opaqueRef: React.MutableRefObject<Map<string, OpaqueRedmineSource>>) {
  return Node.create({
    name: 'redminePreserved',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    addAttributes() { return { marker: { default: '' }, raw: { default: '' }, label: { default: '' } }; },
    addNodeView() { return ReactNodeViewRenderer(PreservedSourceView); },
    markdownTokenName: 'redminePreserved',
    markdownTokenizer: {
      name: 'redminePreserved', level: 'inline',
      start: (source: string) => source.indexOf('RDMOPAQUE'),
      tokenize: (source: string) => {
        const match = source.match(/^RDMOPAQUE\d+END/);
        if (!match || !opaqueRef.current.has(match[0])) return undefined;
        return { type: 'redminePreserved', raw: match[0], text: match[0], tokens: [] };
      },
    },
    parseMarkdown(token) {
      const marker = String((token as { raw?: string }).raw || '');
      const item = opaqueRef.current.get(marker);
      return item ? { type: 'redminePreserved', attrs: { marker, raw: item.raw, label: item.label } } : { type: 'text', text: marker };
    },
    renderMarkdown(node) { return String(node.attrs?.marker || node.attrs?.raw || ''); },
    parseHTML() { return [{ tag: 'span[data-preserved-source]' }]; },
    renderHTML({ node }) { return ['span', { 'data-preserved-source': 'true' }, String(node.attrs.raw || '')]; },
  });
}

interface ImagePresentation {
  issueId?: number; attachments: Attachment[]; redmineUrl: string;
  unavailableText: string; openOriginalText: string; retryText: string; loadingText: string;
}

function RedmineImageView({ node, selected, presentationRef }: NodeViewProps & { presentationRef: React.MutableRefObject<ImagePresentation> }) {
  const image = presentationRef.current;
  const imageSource = String(node.attrs.source || '');
  const alt = String(node.attrs.alt || '');
  // Let ProseMirror handle the selectable NodeView click. Its click path focuses
  // the view synchronously before dispatching NodeSelection; preventing mousedown
  // here leaves keyboard deletion dependent on a later focus animation frame.
  return <NodeViewWrapper as="span" className={'redmine-source-image' + (selected ? ' is-selected' : '')} contentEditable={false}
    title={String(node.attrs.raw || '')} data-redmine-source-image="true" aria-label={alt || image.unavailableText}>
    <SafeRichImage src={imageSource} alt={alt} issueId={image.issueId || 0} attachments={image.attachments} redmineUrl={image.redmineUrl}
      unavailableText={image.unavailableText} openOriginalText={image.openOriginalText} retryText={image.retryText} loadingText={image.loadingText} linkImage={false} />
  </NodeViewWrapper>;
}

function createImageNode(imagesRef: React.MutableRefObject<Map<string, RedmineSourceImage>>, presentationRef: React.MutableRefObject<ImagePresentation>) {
  return Node.create({
    name: 'redmineImage',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return {
        marker: { default: '' }, raw: { default: '' }, source: { default: '' }, alt: { default: '' },
      };
    },
    addNodeView() {
      return ReactNodeViewRenderer((props) => <RedmineImageView {...props} presentationRef={presentationRef} />);
    },
    markdownTokenName: 'redmineImage',
    markdownTokenizer: {
      name: 'redmineImage',
      level: 'inline',
      start: (source: string) => source.indexOf('RDMIMAGE'),
      tokenize: (source: string) => {
        const match = source.match(/^RDMIMAGE\d+END/);
        if (!match || !imagesRef.current.has(match[0])) return undefined;
        return { type: 'redmineImage', raw: match[0], text: match[0], tokens: [] };
      },
    },
    parseMarkdown(token) {
      const marker = String((token as { raw?: string }).raw || '');
      const image = imagesRef.current.get(marker);
      return image ? { type: 'redmineImage', attrs: { marker, raw: image.raw, source: image.source, alt: image.alt } } : { type: 'text', text: marker };
    },
    renderMarkdown(node) { return String(node.attrs?.marker || node.attrs?.raw || ''); },
    renderHTML({ node }) {
      return ['span', {
        'data-redmine-source-image': 'true',
        'data-marker': String(node.attrs.marker || ''),
        'data-source': String(node.attrs.source || ''),
        'data-alt': String(node.attrs.alt || ''),
        'data-raw': String(node.attrs.raw || ''),
      }];
    },
  });
}

function findMention(text: string, caret: number): { query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)@([^\s@<>]*)$/);
  if (!match) return undefined;
  return { query: match[2] || '', start: before.length - (match[2] || '').length - 1 };
}

function mentionChoices(people: Person[], query: string): MentionChoice[] {
  const normalized = query.toLocaleLowerCase();
  return people.flatMap((person) => {
    const token = person.mentionToken;
    if (!token || !/^@[\S]+$/.test(token) || !token.slice(1).toLocaleLowerCase().startsWith(normalized)) return [];
    return [{ token, name: person.name, id: person.id }];
  }).slice(0, 8);
}

function safeLink(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^(?:https?:|mailto:)/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? trimmed : undefined;
    } catch { return undefined; }
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || !/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  return undefined;
}

export function RichEditor({ source, format, onChange, label, placeholder, className = '', people = [], testId, disabled = false, focusRequest = 0,
  issueId, attachments = [], redmineUrl = '', imageUnavailableText, openOriginalText, retryImageText, imageLoadingText }: {
  source: string; format?: string; onChange: (source: string) => void; label: string; placeholder?: string; className?: string;
  people?: Person[]; testId?: string; disabled?: boolean; focusRequest?: number;
  issueId?: number; attachments?: Attachment[]; redmineUrl?: string; imageUnavailableText?: string; openOriginalText?: string; retryImageText?: string; imageLoadingText?: string;
}) {
  const { t } = useTranslation();
  const normalizedFormat = normalizeRedmineTextFormat(format);
  const valueRef = useRef(source);
  const formatRef = useRef(normalizedFormat);
  const preparedRef = useRef<PreparedRedmineSource>(prepareRedmineSource(source, format));
  const opaqueRef = useRef<Map<string, OpaqueRedmineSource>>(preparedRef.current.opaque);
  const imagesRef = useRef<Map<string, RedmineSourceImage>>(preparedRef.current.images);
  const imagePresentationRef = useRef<ImagePresentation>({
    issueId, attachments, redmineUrl,
    unavailableText: imageUnavailableText || 'Image unavailable',
    openOriginalText: openOriginalText || 'Open original image',
    retryText: retryImageText || 'Retry',
    loadingText: imageLoadingText || 'Loading',
  });
  const editedVisuallyRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const peopleRef = useRef(people);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const sourceTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(source);
  const [mode, setMode] = useState<'visual' | 'source'>(preparedRef.current.visualSupported ? 'visual' : 'source');
  const [mention, setMention] = useState<MentionPopup | undefined>(undefined);
  const mentionRef = useRef<MentionPopup | undefined>(undefined);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionIndexRef = useRef(mentionIndex);
  const [codeLanguage, setCodeLanguage] = useState('text');
  const menuRef = useRef<HTMLDivElement>(null);
  const opaqueExtension = useMemo(() => createPreservedNode(opaqueRef), []);
  const imageExtension = useMemo(() => createImageNode(imagesRef, imagePresentationRef), []);
  onChangeRef.current = onChange;
  peopleRef.current = people;
  imagePresentationRef.current = {
    issueId, attachments, redmineUrl,
    unavailableText: imageUnavailableText || t('imageUnavailable'),
    openOriginalText: openOriginalText || t('openImageOriginal'),
    retryText: retryImageText || t('retry'),
    loadingText: imageLoadingText || t('loading'),
  };
  mentionRef.current = mention;
  mentionIndexRef.current = mentionIndex;

  const publish = useCallback((next: string) => {
    valueRef.current = next;
    setValue(next);
    onChangeRef.current(next);
  }, []);

  const refreshVisualMention = useCallback((editor: NonNullable<ReturnType<typeof useEditor>>) => {
    const { selection } = editor.state;
    if (!selection.empty) { setMention(undefined); setMentionIndex(0); return; }
    const parent = selection.$from.parent;
    const text = parent.textBetween(0, selection.$from.parentOffset, '\ufffc');
    const found = findMention(text, text.length);
    if (!found) { setMention(undefined); setMentionIndex(0); return; }
    try {
      const coords = editor.view.coordsAtPos(selection.from);
      setMention({ query: found.query, from: selection.from - (text.length - found.start), to: selection.to, left: coords.left, top: coords.bottom + 5 });
      setMentionIndex(0);
    } catch { setMention(undefined); }
  }, []);

  const insertVisualMention = useCallback((choice: MentionChoice) => {
    const editor = editorRef.current;
    const active = mentionRef.current;
    if (!editor || !active) return;
    editor.chain().focus().insertContentAt({ from: active.from, to: active.to }, choice.token + ' ').run();
    setMention(undefined);
  }, []);

  const editor = useEditor({
    extensions: [StarterKit.configure({ codeBlock: { defaultLanguage: null } }), Markdown.configure({ markedOptions: { gfm: true } }), opaqueExtension, imageExtension],
    content: preparedRef.current.visualSupported ? preparedRef.current.markdown : '',
    contentType: 'markdown',
    immediatelyRender: false,
    editable: !disabled,
    editorProps: {
      attributes: { 'aria-label': label, class: 'rich-editor-prose formatted-prose' },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229) return false;
        if (!mentionRef.current) return false;
        const choices = mentionChoices(peopleRef.current, mentionRef.current.query);
        if (event.key === 'ArrowDown' && choices.length) { event.preventDefault(); setMentionIndex((current) => (current + 1) % choices.length); return true; }
        if (event.key === 'ArrowUp' && choices.length) { event.preventDefault(); setMentionIndex((current) => (current - 1 + choices.length) % choices.length); return true; }
        if (event.key === 'Enter' && choices.length) { event.preventDefault(); insertVisualMention(choices[Math.min(mentionIndexRef.current, choices.length - 1)]!); return true; }
        if (event.key === 'Escape') { event.preventDefault(); setMention(undefined); return true; }
        return false;
      },
    },
    onCreate: ({ editor: created }) => { editorRef.current = created; },
    onUpdate: ({ editor: updated, transaction, appendedTransactions }) => {
      // `setEditable` and selection-only transactions can emit an update
      // without changing the document. Source must only be serialized after a
      // real content edit in the visual editor.
      if (!transaction.docChanged && !appendedTransactions.some((appended) => appended.docChanged)) return;
      editedVisuallyRef.current = true;
      const serialized = serializeRedmineSource(updated.getMarkdown(), preparedRef.current);
      publish(serialized);
      refreshVisualMention(updated);
    },
    onSelectionUpdate: ({ editor: updated }) => refreshVisualMention(updated),
  });
  editorRef.current = editor;

  useEffect(() => {
    if (source === valueRef.current && normalizedFormat === formatRef.current) return;
    const formatChanged = normalizedFormat !== formatRef.current;
    valueRef.current = source;
    formatRef.current = normalizedFormat;
    setValue(source);
    preparedRef.current = prepareRedmineSource(source, format);
    opaqueRef.current = preparedRef.current.opaque;
    imagesRef.current = preparedRef.current.images;
    editedVisuallyRef.current = false;
    // An external value update (for example, quoting a journal into a comment
    // draft or clearing a successfully submitted comment) must not override
    // the user's explicit Source/Visual choice for the same formatter.
    if (formatChanged || !preparedRef.current.visualSupported) {
      setMode(preparedRef.current.visualSupported ? 'visual' : 'source');
    }
    setMention(undefined);
    if (editor) {
      editor.commands.setContent(preparedRef.current.visualSupported ? preparedRef.current.markdown : '', { contentType: 'markdown', emitUpdate: false });
      editor.view.dispatch(editor.state.tr.setStoredMarks(null));
    }
  }, [source, format, normalizedFormat, editor]);

  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => {
    if (focusRequest <= 0) return;
    if (mode === 'visual') {
      editor?.commands.focus('end');
      return;
    }
    // External updates and a focus request can land in the same React commit.
    // Read the textarea after its controlled value has rendered, not the prior
    // draft length, and cancel if this editor changes mode or unmounts first.
    const frame = requestAnimationFrame(() => {
      const textarea = sourceTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, focusRequest, mode]);

  const enterVisualMode = () => {
    const prepared = prepareRedmineSource(valueRef.current, format);
    preparedRef.current = prepared;
    opaqueRef.current = prepared.opaque;
    imagesRef.current = prepared.images;
    editedVisuallyRef.current = false;
    if (prepared.visualSupported && editor) {
      editor.commands.setContent(prepared.markdown, { contentType: 'markdown', emitUpdate: false });
      editor.view.dispatch(editor.state.tr.setStoredMarks(null));
    }
    setMode(prepared.visualSupported ? 'visual' : 'source');
    setMention(undefined);
  };
  const enterSourceMode = () => {
    if (editor && editedVisuallyRef.current) publish(serializeRedmineSource(editor.getMarkdown(), preparedRef.current));
    setMode('source');
    setMention(undefined);
    requestAnimationFrame(() => sourceTextareaRef.current?.focus());
  };

  const updateSourceMention = (element: HTMLTextAreaElement) => {
    const found = findMention(element.value, element.selectionStart);
    if (!found) { setMention(undefined); return; }
    const rect = element.getBoundingClientRect();
    setMention({ query: found.query, from: found.start, to: element.selectionStart, left: rect.left + 12, top: rect.top + 30 });
    setMentionIndex(0);
  };
  const insertSourceMention = (choice: MentionChoice) => {
    const textarea = sourceTextareaRef.current;
    const active = mentionRef.current;
    if (!textarea || !active) return;
    const next = value.slice(0, active.from) + choice.token + ' ' + value.slice(active.to);
    publish(next);
    setMention(undefined);
    requestAnimationFrame(() => { textarea.focus(); const caret = active.from + choice.token.length + 1; textarea.setSelectionRange(caret, caret); });
  };
  const choices = mention ? mentionChoices(people, mention.query) : [];
  const onSourceKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!mention) return;
    if (event.key === 'ArrowDown' && choices.length) { event.preventDefault(); setMentionIndex((current) => (current + 1) % choices.length); }
    else if (event.key === 'ArrowUp' && choices.length) { event.preventDefault(); setMentionIndex((current) => (current - 1 + choices.length) % choices.length); }
    else if (event.key === 'Enter' && choices.length) { event.preventDefault(); insertSourceMention(choices[Math.min(mentionIndex, choices.length - 1)]!); }
    else if (event.key === 'Escape') { event.preventDefault(); setMention(undefined); }
  };

  const runLink = () => {
    if (!editor) return;
    const answer = window.prompt(t('link'), 'https://');
    if (!answer) return;
    const href = safeLink(answer);
    if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };
  const toolbarButton = (title: string, icon: React.ReactNode, action: () => void, active = false, dataTest?: string) =>
    <button key={title} type="button" className={`rich-editor-tool${active ? ' is-active' : ''}`} aria-label={title} title={title} disabled={disabled || !editor} onClick={action} data-testid={dataTest}>{icon}</button>;
  const canUseCodeBlock = normalizedFormat === 'textile' || normalizedFormat === 'markdown' || normalizedFormat === 'common_mark';

  return <div className={`rich-editor ${className}`.trim()} data-testid={testId} data-format={normalizedFormat}>
    <div className="rich-editor-toolbar" role="toolbar" aria-label={t('visualEditor')}>
      <div className="rich-editor-tools" hidden={mode !== 'visual' || !preparedRef.current.visualSupported}>
        {toolbarButton(t('bold'), <Bold size={14} />, () => editor?.chain().focus().toggleBold().run(), Boolean(editor?.isActive('bold')))}
        {toolbarButton(t('italic'), <Italic size={14} />, () => editor?.chain().focus().toggleItalic().run(), Boolean(editor?.isActive('italic')))}
        {toolbarButton(t('strikethrough'), <Strikethrough size={14} />, () => editor?.chain().focus().toggleStrike().run(), Boolean(editor?.isActive('strike')))}
        {toolbarButton(t('inlineCode'), <Code size={14} />, () => editor?.chain().focus().toggleCode().run(), Boolean(editor?.isActive('code')))}
        {canUseCodeBlock && <label className="rich-code-language"><span>{t('codeBlock')}</span><select aria-label={t('codeBlock')} data-testid={testId ? `${testId}-code-language` : undefined} value={codeLanguage} disabled={disabled || !editor} onChange={(event) => { const language = event.target.value; setCodeLanguage(language); editor?.chain().focus().toggleCodeBlock({ language: language === 'text' ? '' : language }).run(); }}>
          {['text', 'javascript', 'typescript', 'tsx', 'python', 'ruby', 'json', 'html', 'css', 'bash', 'sql'].map((language) => <option key={language} value={language}>{language}</option>)}
        </select><CodeXml size={13} /></label>}
        {toolbarButton(t('heading'), <Heading2 size={14} />, () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), Boolean(editor?.isActive('heading')))}
        {toolbarButton(t('bulletedList'), <List size={14} />, () => editor?.chain().focus().toggleBulletList().run(), Boolean(editor?.isActive('bulletList')))}
        {toolbarButton(t('numberedList'), <ListOrdered size={14} />, () => editor?.chain().focus().toggleOrderedList().run(), Boolean(editor?.isActive('orderedList')))}
        {toolbarButton(t('blockquote'), <Quote size={14} />, () => editor?.chain().focus().toggleBlockquote().run(), Boolean(editor?.isActive('blockquote')))}
        {toolbarButton(t('link'), <Link2 size={14} />, runLink, Boolean(editor?.isActive('link')))}
      </div>
      <div className="rich-editor-mode" role="group" aria-label={t('source')}>
        {normalizedFormat !== 'unsupported' && <button type="button" className={mode === 'visual' ? 'is-selected' : ''} aria-pressed={mode === 'visual'} onClick={enterVisualMode} disabled={disabled} data-testid={testId ? `${testId}-visual-toggle` : undefined}>{t('visualEditor')}</button>}
        <button type="button" className={mode === 'source' ? 'is-selected' : ''} aria-pressed={mode === 'source'} onClick={enterSourceMode} disabled={disabled} data-testid={testId ? `${testId}-source-toggle` : undefined}>{t('source')}</button>
      </div>
    </div>
    {preparedRef.current.visualSupported && <div className="rich-editor-canvas" hidden={mode !== 'visual'} aria-hidden={mode !== 'visual'}
      onClick={(event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-preserved-source]')) return;
      if (target.closest('[contenteditable="true"]')) return;
      editor?.commands.focus();
    }}>
      <EditorContent editor={editor} data-testid={testId ? testId + '-visual' : undefined} />
      {!value && placeholder && <span className="rich-editor-placeholder">{placeholder}</span>}
    </div>}
    {!preparedRef.current.visualSupported && <div className="rich-editor-warning" role="note">{t('formattingSourceRequired')}</div>}
    {mode === 'source' && <textarea ref={sourceTextareaRef} className="rich-editor-source" aria-label={label + ' — ' + t('source')} value={value} placeholder={placeholder} disabled={disabled} data-testid={testId ? testId + '-source' : undefined} onChange={(event) => { publish(event.target.value); updateSourceMention(event.target); }} onClick={(event) => updateSourceMention(event.currentTarget)} onKeyUp={(event) => updateSourceMention(event.currentTarget)} onKeyDown={onSourceKeyDown} />}
    {mention && <div ref={menuRef} className="rich-mention-menu" role="listbox" aria-label={t('mentionSuggestions')} style={{ left: mention.left, top: mention.top }}>
      {choices.length ? choices.map((choice, index) => <button type="button" role="option" aria-selected={index === mentionIndex} key={`${choice.id}:${choice.token}`} className={index === mentionIndex ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => mode === 'visual' ? insertVisualMention(choice) : insertSourceMention(choice)}><strong>{choice.name}</strong><code>{choice.token}</code></button>) : <span role="status">{t('mentionUnavailable')}</span>}
    </div>}
  </div>;
}
