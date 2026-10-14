import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue, IssueDetail } from '../src/shared/types.js';

const previewText = `# Повний опис

Звичайний абзац із **виділенням**, [посиланням](https://example.com/tasks) та \`inline code\`.

> Цитата містить довгий український текст, який має переноситися в межах картки без зайвих порожніх рядків.
>
> Другий рядок цитати зберігає той самий ритм і відступ.

- Перший довгий пункт списку з достатнім текстом для перевірки геометрії.
- Другий пункт із вкладеним рядком.
  - Вкладений пункт лишається маркованим.

1. Перший нумерований крок.
2. Другий нумерований крок.

---

## Код і завершальний абзац

\`\`\`ts
const result = 42;
console.log(result);
\`\`\`

Завершальний абзац після розділювача.`;

async function createIssue(request: APIRequestContext) {
  await request.patch('/api/settings', { data: { locale: 'uk', theme: 'light', palette: 'blue' } });
  const bootstrap = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(bootstrap.mode).toBe('demo');
  const todo = bootstrap.statuses.find(status => status.key === 'todo');
  expect(todo).toBeTruthy();
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue',
    projectId: bootstrap.projects[0]!.id,
    input: { subject: `Preview parity ${Date.now()}`, description: previewText, statusId: todo!.id },
  } });
  expect(response.ok()).toBe(true);
  const issue = (await response.json() as CommandResult).issue;
  expect(issue).toBeTruthy();
  return issue!;
}

async function installCommonMarkDetail(page: Page, issue: Issue) {
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    await route.fulfill({ response, json: { ...detail, textFormat: 'common_mark' } });
  });
}

async function measureProse(locator: Locator) {
  return locator.evaluate(root => {
    const rootStyle = getComputedStyle(root);
    const rootRect = root.getBoundingClientRect();
    const nestedListParent = root.querySelector<HTMLElement>('ul > li > ul')?.parentElement as HTMLElement | null;
    const listItemTree = nestedListParent ? [nestedListParent, ...Array.from(nestedListParent.querySelectorAll<HTMLElement>('p, ul, li'))].map(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        text: element.innerText,
        innerHTML: element === nestedListParent ? element.innerHTML : undefined,
        relativeBounds: [
          Math.round((rect.left - rootRect.left) * 100) / 100,
          Math.round((rect.top - rootRect.top) * 100) / 100,
          Math.round(rect.width * 100) / 100,
          Math.round(rect.height * 100) / 100,
        ],
        margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        lineHeight: style.lineHeight,
        display: style.display,
        whiteSpace: style.whiteSpace,
      };
    }) : [];
    const selectors = [
      ['paragraphs', 'p'], ['unordered lists', 'ul'], ['ordered lists', 'ol'],
      ['list items', 'li'], ['quotes', 'blockquote'], ['h1', 'h1'], ['h2', 'h2'],
      ['rules', 'hr'], ['code blocks', 'pre'], ['inline code', ':not(pre) > code'], ['block code', 'pre > code'],
    ] as const;
    const blocks: Record<string, Array<Record<string, unknown>>> = {};
    for (const [name, selector] of selectors) {
      const matchingElements = Array.from(root.querySelectorAll(selector));
      const measuredElements = name === 'paragraphs'
        ? matchingElements.filter(element => !element.closest('li'))
        : matchingElements;
      blocks[name] = measuredElements.map(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          text: element.textContent,
          visibleText: (element as HTMLElement).innerText,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          display: style.display,
          whiteSpace: style.whiteSpace,
          listStyleType: style.listStyleType,
          margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          borderLeftWidth: style.borderLeftWidth,
          relativeBounds: [
            Math.round((rect.left - rootRect.left) * 100) / 100,
            Math.round((rect.top - rootRect.top) * 100) / 100,
            Math.round(rect.width * 100) / 100,
            Math.round(rect.height * 100) / 100,
          ],
        };
      });
    }
    return {
      root: {
        fontSize: rootStyle.fontSize,
        lineHeight: rootStyle.lineHeight,
        whiteSpace: rootStyle.whiteSpace,
        padding: [rootStyle.paddingTop, rootStyle.paddingRight, rootStyle.paddingBottom, rootStyle.paddingLeft],
        backgroundColor: rootStyle.backgroundColor,
      },
      directChildren: Array.from(root.children).map(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className.toString(),
          text: (element as HTMLElement).innerText,
          relativeBounds: [
            Math.round((rect.left - rootRect.left) * 100) / 100,
            Math.round((rect.top - rootRect.top) * 100) / 100,
            Math.round(rect.width * 100) / 100,
            Math.round(rect.height * 100) / 100,
          ],
          margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
        };
      }),
      nestedListParent: nestedListParent ? {
        outerHTML: nestedListParent.outerHTML,
        descendants: listItemTree,
      } : undefined,
      blocks,
    };
  });
}

type ProseMeasure = Awaited<ReturnType<typeof measureProse>>;

function comparableText(name: string, block: Record<string, unknown>) {
  const text = String(block.text ?? '');
  if (name === 'code blocks' || name === 'block code') {
    // Markdown code fences commonly retain one terminal LF; Tiptap can omit it.
    return text.replace(/\n$/, '');
  }
  if (name === 'unordered lists' || name === 'ordered lists' || name === 'list items' || name === 'quotes') {
    // Renderer and editor may put paragraph wrappers around tight-list/quote text.
    // Compare visible words while real line wrapping remains covered by bounds below.
    return String(block.visibleText ?? text).replace(/\s+/g, ' ').trim();
  }
  return text;
}

function assertProseParity(previewMeasure: ProseMeasure, editorMeasure: ProseMeasure) {
  // ProseMirror intentionally preserves editable whitespace for cursor/input behavior.
  // Preview uses normal flow so block-renderer whitespace cannot become visible gaps.
  expect(previewMeasure.root.whiteSpace).toBe('normal');
  expect(editorMeasure.root.whiteSpace).toMatch(/^(break-spaces|pre-wrap)$/);
  const { whiteSpace: _previewWhiteSpace, ...previewStyle } = previewMeasure.root;
  const { whiteSpace: _editorWhiteSpace, ...editorStyle } = editorMeasure.root;
  expect(previewStyle).toEqual(editorStyle);
  expect(Object.keys(previewMeasure.blocks)).toEqual(Object.keys(editorMeasure.blocks));
  for (const [name, previewBlocks] of Object.entries(previewMeasure.blocks)) {
    const editorBlocks = editorMeasure.blocks[name];
    expect(editorBlocks, `the editor has ${name}`).toBeDefined();
    expect(previewBlocks.length, `the preview contains ${name}`).toBeGreaterThan(0);
    expect(previewBlocks).toHaveLength(editorBlocks!.length);
    for (let index = 0; index < previewBlocks.length; index += 1) {
      const previewBlock = previewBlocks[index]!;
      const editorBlock = editorBlocks![index]!;
      expect(comparableText(name, previewBlock)).toBe(comparableText(name, editorBlock));
      expect(previewBlock.fontSize).toBe(editorBlock.fontSize);
      expect(previewBlock.lineHeight).toBe(editorBlock.lineHeight);
      expect(previewBlock.display).toBe(editorBlock.display);
      expect(previewBlock.listStyleType).toBe(editorBlock.listStyleType);
      expect(previewBlock.margin).toEqual(editorBlock.margin);
      expect(previewBlock.padding).toEqual(editorBlock.padding);
      expect(previewBlock.borderLeftWidth).toBe(editorBlock.borderLeftWidth);
      if (name === 'code blocks' || name === 'block code') {
        expect(previewBlock.whiteSpace).toBe('pre-wrap');
        expect(editorBlock.whiteSpace).toBe('pre-wrap');
      }
      const previewBounds = previewBlock.relativeBounds as number[];
      const editorBounds = editorBlock.relativeBounds as number[];
      const blockText = comparableText(name, previewBlock);
      const boundsMessage = `${name}[${index}] "${blockText}" Preview=${JSON.stringify(previewBounds)} VisualEdit=${JSON.stringify(editorBounds)}`;
      expect(previewBounds[0], `${boundsMessage} left`).toBeCloseTo(editorBounds[0]!, 1);
      expect(previewBounds[1], `${boundsMessage} top`).toBeCloseTo(editorBounds[1]!, 1);
      expect(previewBounds[2], `${boundsMessage} width`).toBeCloseTo(editorBounds[2]!, 1);
      expect(previewBounds[3], `${boundsMessage} height`).toBeCloseTo(editorBounds[3]!, 1);
    }
  }
}

async function measureThemeSurface(previewFrame: Locator) {
  return previewFrame.evaluate(preview => {
    const modal = preview.closest('.issue-dialog');
    if (!modal) return undefined;
    const probe = document.createElement('div');
    // Resolve theme tokens in the fixture's actual scope. Some demo issues
    // intentionally omit the footer, so it cannot be the only --surface-alt probe.
    Object.assign(probe.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none',
      visibility: 'hidden',
    });
    modal.append(probe);
    probe.style.backgroundColor = 'var(--surface)';
    const surface = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = 'var(--surface-alt)';
    const surfaceAlt = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      preview: getComputedStyle(preview).backgroundColor,
      modal: getComputedStyle(modal).backgroundColor,
      surface,
      surfaceAlt,
    };
  });
}

function assertPreviewSurface(colors: Awaited<ReturnType<typeof measureThemeSurface>>) {
  expect(colors).toBeDefined();
  expect(colors!.preview).toBe('rgba(0, 0, 0, 0)');
  expect(colors!.modal).toBe(colors!.surface);
  expect(colors!.modal).not.toBe(colors!.surfaceAlt);
}

test('description Preview and Visual Edit share prose styles and measured block geometry in light and dark themes', async ({ page, request }) => {
  const issue = await createIssue(request);
  await installCommonMarkDetail(page, issue);
  const editorChunkPattern = /(?:^|\/)RichEditor-[^/?]+\.js(?:\?|$)/i;
  const editorChunkRequests: string[] = [];
  page.on('request', request => {
    if (editorChunkPattern.test(new URL(request.url()).pathname)) editorChunkRequests.push(request.url());
  });
  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);

  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  const previewFrame = dialog.getByTestId('issue-description-preview');
  const preview = previewFrame.locator('.rich-content.formatted-prose');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Перший довгий пункт списку');
  expect(editorChunkRequests, 'cold issue navigation must not fetch the visual editor chunk').toEqual([]);
  const previewImage = test.info().outputPath('round5-description-preview.png');
  await page.screenshot({ path: previewImage, animations: 'disabled' });
  await test.info().attach('description-preview', { path: previewImage, contentType: 'image/png' });
  const [previewMeasure, previewFrameBackground] = await Promise.all([
    measureProse(preview),
    previewFrame.evaluate(element => getComputedStyle(element).backgroundColor),
  ]);
  expect(previewMeasure.root.fontSize).toBe('13px');
  expect(Number.parseFloat(previewMeasure.root.lineHeight)).toBeCloseTo(20.15, 1);
  expect(previewMeasure.root.whiteSpace).toBe('normal');
  expect(previewMeasure.root.padding).toEqual(['10px', '12px', '10px', '12px']);
  expect(previewFrameBackground).toBe('rgba(0, 0, 0, 0)');
  assertPreviewSurface(await measureThemeSurface(previewFrame));

  await dialog.getByTestId('issue-description-edit-toggle').click();
  const editor = dialog.getByTestId('issue-description-editor-visual');
  const editorProse = editor.locator('.rich-editor-prose.formatted-prose');
  await expect(editorProse).toBeVisible();
  await expect.poll(() => editorChunkRequests.length, { message: 'Edit loads the lazy RichEditor chunk' }).toBeGreaterThan(0);
  expect(editorChunkRequests.every(url => editorChunkPattern.test(new URL(url).pathname))).toBe(true);
  const editorMeasure = await measureProse(editorProse);
  const geometryPath = test.info().outputPath('round5-preview-parity-geometry.json');
  const geometryEvidence = JSON.stringify({ preview: previewMeasure, visualEdit: editorMeasure }, null, 2);
  await writeFile(geometryPath, geometryEvidence);
  const editorImage = test.info().outputPath('round5-description-visual-edit.png');
  await page.screenshot({ path: editorImage, animations: 'disabled' });
  await test.info().attach('visual-edit', { path: editorImage, contentType: 'image/png' });
  await test.info().attach('prose-geometry.json', {
    path: geometryPath, contentType: 'application/json',
  });
  assertProseParity(previewMeasure, editorMeasure);

  await request.patch('/api/settings', { data: { theme: 'dark' } });
  await page.reload();
  await expect(dialog).toBeVisible();
  const darkPreviewFrame = dialog.getByTestId('issue-description-preview');
  const darkPreview = darkPreviewFrame.locator('.rich-content.formatted-prose');
  await expect(darkPreview).toBeVisible();
  assertPreviewSurface(await measureThemeSurface(darkPreviewFrame));
  const darkPreviewMeasure = await measureProse(darkPreview);
  expect(darkPreviewMeasure.root.fontSize).toBe('13px');
  expect(darkPreviewMeasure.root.padding).toEqual(['10px', '12px', '10px', '12px']);
  const darkPreviewImage = test.info().outputPath('round5-description-preview-dark.png');
  await page.screenshot({ path: darkPreviewImage, animations: 'disabled' });
  await test.info().attach('description-preview-dark', { path: darkPreviewImage, contentType: 'image/png' });

  await dialog.getByTestId('issue-description-edit-toggle').click();
  const darkEditor = dialog.getByTestId('issue-description-editor-visual');
  const darkEditorProse = darkEditor.locator('.rich-editor-prose.formatted-prose');
  await expect(darkEditorProse).toBeVisible();
  assertProseParity(darkPreviewMeasure, await measureProse(darkEditorProse));
});
