import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { Attachment, BoardData, Bootstrap, CommandResult, Issue, IssueDetail, Person } from '../src/shared/types.js';
import { sourceEditor } from './helpers/rich-editor.js';

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p+0AAAAASUVORK5CYII=', 'base64');

async function makeIssue(request: APIRequestContext, description = '') {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light', palette: 'blue' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject: `Round five editor ${Date.now()}`, description, statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(response.ok()).toBe(true);
  const issue = (await response.json() as CommandResult).issue!;
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  return { boot, issue, detail };
}

async function routeIssueDetail(page: Page, issue: Issue, mutate: (detail: IssueDetail) => IssueDetail) {
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    await route.fulfill({ response, json: mutate(detail) });
  });
}

async function openIssue(page: Page, issue: Issue) {
  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
}

async function recordBoldActivations(page: Page, testId: string) {
  await page.getByTestId(testId).evaluate(element => {
    const events: unknown[] = [];
    (window as any).__round5BoldClickEvents = events;
    element.querySelector('button[aria-label="Bold"]')?.addEventListener('click', event => events.push({ detail: (event as MouseEvent).detail, trusted: event.isTrusted }), true);
  });
}

async function expectNoBoldActivation(page: Page) {
  expect(await page.evaluate(() => (window as any).__round5BoldClickEvents)).toEqual([]);
}

function visualEditor(page: Page, testId: string) {
  return page.getByTestId(`${testId}-visual`).locator('[contenteditable="true"]');
}

async function textBoundaryPoint(text: ReturnType<Page['getByText']>, needle: string) {
  return text.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent || '').includes(target)) node = walker.nextNode();
    if (!node) throw new Error(`Could not find ${target} in a text node`);
    const value = node.textContent || '';
    const start = value.indexOf(target);
    if (start < 0) throw new Error(`Could not find ${target} in the paragraph`);
    const pointAt = (offset: number) => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    };
    return { start: pointAt(start), end: pointAt(start + target.length) };
  }, needle);
}

test('single clicks place the caret and Shift-click keeps a selected range for formatting', async ({ page, request }) => {
  const phrase = 'short phrase';
  const { issue } = await makeIssue(request, 'Select a short phrase inside this paragraph.');
  await routeIssueDetail(page, issue, detail => ({ ...detail, textFormat: 'markdown' }));
  await openIssue(page, issue);

  const preview = page.getByTestId('issue-dialog').getByTestId('issue-description-preview');
  await preview.getByText('Select a short phrase inside this paragraph.', { exact: true }).click();
  const root = page.getByTestId('issue-description-editor');
  const editor = visualEditor(page, 'issue-description-editor');
  const paragraph = editor.getByText('Select a short phrase inside this paragraph.', { exact: true });
  await expect(editor).toBeVisible();
  await expect(root.locator('xpath=ancestor::label')).toHaveCount(0);
  await recordBoldActivations(page, 'issue-description-editor');
  const boundaries = await textBoundaryPoint(paragraph, phrase);
  await page.mouse.click(boundaries.start.x, boundaries.start.y);
  await expectNoBoldActivation(page);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
  await page.keyboard.down('Shift');
  try { await page.mouse.click(boundaries.end.x, boundaries.end.y); }
  finally { await page.keyboard.up('Shift'); }
  await expectNoBoldActivation(page);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(phrase);

  // An ordinary click collapses the old range, while a real drag creates and
  // preserves a new range for the formatting command.
  await page.mouse.click(boundaries.start.x, boundaries.start.y);
  await expectNoBoldActivation(page);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
  await page.mouse.move(boundaries.start.x, boundaries.start.y);
  await page.mouse.down();
  await page.mouse.move(boundaries.end.x, boundaries.end.y, { steps: 8 });
  await page.mouse.up();
  await expectNoBoldActivation(page);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(phrase);

  await root.getByRole('button', { name: 'Bold', exact: true }).click();
  const source = await sourceEditor(page, 'issue-description-editor');
  expect(await source.inputValue()).toContain(`**${phrase}**`);
  expect(await source.inputValue()).toContain('Select a **short phrase** inside this paragraph.');
});

test('switching an untouched Markdown draft to source mode preserves its autolink spelling', async ({ page, request }) => {
  const source = 'Existing reference https://docs.example.test/guide';
  const { issue } = await makeIssue(request, source);
  await routeIssueDetail(page, issue, detail => ({ ...detail, textFormat: 'markdown' }));
  await openIssue(page, issue);
  await page.getByTestId('issue-description-edit-toggle').click();
  expect(await (await sourceEditor(page, 'issue-description-editor')).inputValue()).toBe(source);
});

test('create description uses a non-label wrapper and pointer focus does not activate Bold', async ({ page, request }) => {
  const { issue } = await makeIssue(request);
  await page.goto(`/?project=${issue.projectId}`);
  await page.getByRole('button', { name: 'New issue', exact: true }).click();

  const root = page.getByTestId('issue-description-editor');
  const editor = visualEditor(page, 'issue-description-editor');
  await expect(editor).toBeVisible();
  await expect(root.locator('xpath=ancestor::label')).toHaveCount(0);
  await recordBoldActivations(page, 'issue-description-editor');
  await editor.click();
  await expectNoBoldActivation(page);

  await root.getByTestId('issue-description-editor-source-toggle').click();
  await expect(editor).toBeHidden();
  await expect(page.getByTestId('issue-description-editor-source')).toBeVisible();
  await page.getByTestId('issue-description-editor-source').fill('draft stays in source');
  await root.getByTestId('issue-description-editor-visual-toggle').click();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('draft stays in source');
});

test('default preview links stay links, and Textile visual edits preserve macros, multiline quotes, tables, nested lists and code source', async ({ page, request }) => {
  const source = [
    'h2. Keep this title',
    '',
    'p. Existing *strong* and _italic_ text.',
    '',
    '* Parent item',
    '** Nested item',
    '',
    'bq..',
    'Quote line one',
    'Quote line two',
    '',
    'bc. ruby',
    "puts 'kept code'",
    '',
    '| Name | Result |',
    '| --- | --- |',
    '| table | stays intact |',
    '',
    '{{toc}}',
    '',
    'p. Edit this paragraph. Tail text.',
    '',
    '"external guide":https://docs.example.test/guide',
  ].join('\n');
  const { issue } = await makeIssue(request, source);
  await routeIssueDetail(page, issue, detail => ({ ...detail, textFormat: 'textile' }));
  await page.route('https://docs.example.test/**', route => route.fulfill({ contentType: 'text/html', body: 'fixture' }));
  await openIssue(page, issue);

  const dialog = page.getByTestId('issue-dialog');
  const preview = dialog.locator('.description-preview');
  await expect(preview).toBeVisible();
  await expect(visualEditor(page, 'issue-description-editor')).toHaveCount(0);
  await expect(preview.locator('h2')).toHaveText('Keep this title');
  await expect(preview.locator('strong')).toHaveText('strong');
  await expect(preview.locator('em')).toHaveText('italic');
  await expect(preview.locator('ul > li').first()).toContainText('Parent item');
  await expect(preview.locator('ul > li > ul > li')).toContainText('Nested item');
  await expect(preview.locator('table tbody tr')).toHaveCount(1);
  await expect(preview.locator('pre code')).toContainText("puts 'kept code'");
  await expect(preview.locator('blockquote')).toContainText('Quote line one');
  const guide = preview.getByRole('link', { name: 'external guide' });
  await expect(guide).toHaveAttribute('target', '_blank');
  const popupPromise = page.waitForEvent('popup');
  await guide.click();
  const popup = await popupPromise;
  await expect(visualEditor(page, 'issue-description-editor')).toHaveCount(0);
  await popup.close();

  await preview.getByText('Edit this paragraph. Tail text.', { exact: true }).click();
  const editor = visualEditor(page, 'issue-description-editor');
  await expect(editor).toBeVisible();
  const paragraph = editor.getByText('Edit this paragraph. Tail text.', { exact: true });
  const paragraphRange = await textBoundaryPoint(paragraph, 'Edit this paragraph.');
  await page.mouse.click(paragraphRange.start.x, paragraphRange.start.y);
  await page.keyboard.down('Shift');
  try { await page.mouse.click(paragraphRange.end.x, paragraphRange.end.y); }
  finally { await page.keyboard.up('Shift'); }
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Edit this paragraph.');
  await dialog.getByTestId('issue-description-editor').getByRole('button', { name: 'Bold', exact: true }).click();
  const boldParagraph = editor.locator('strong').filter({ hasText: 'Edit this paragraph.' });
  await expect(boldParagraph).toBeVisible();
  await page.keyboard.press('Meta+z');
  await expect(boldParagraph).toHaveCount(0);
  await page.keyboard.press('Meta+Shift+z');
  await expect(boldParagraph).toBeVisible();
  const tail = editor.locator('p').filter({ hasText: 'Tail text.' }).last();
  const tailEnd = await textBoundaryPoint(tail, 'Tail text.');
  await recordBoldActivations(page, 'issue-description-editor');
  await page.mouse.click(tailEnd.end.x, tailEnd.end.y);
  await expectNoBoldActivation(page);
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection();
    const text = selection?.anchorNode?.textContent || '';
    return selection?.isCollapsed && text.includes('Tail text.') && selection.anchorOffset === text.length;
  })).toBe(true);
  await page.keyboard.type(' updated');

  await dialog.getByTestId('issue-description-editor').getByTestId('issue-description-editor-source-toggle').click();
  const sourceEditor = page.getByTestId('issue-description-editor-source');
  const edited = await sourceEditor.inputValue();
  expect(edited).toContain('| Name | Result |\n| --- | --- |\n| table | stays intact |');
  expect(edited).toContain('{{toc}}');
  expect(edited).toContain('* Parent item\n** Nested item');
  expect(edited).toContain('bq..\nQuote line one\nQuote line two');
  expect(edited).toContain("bc. ruby\nputs 'kept code'");
  expect(edited).toContain('*Edit this paragraph.* Tail text. updated');
  expect(edited).toMatch(/\*strong\*/);
  expect(edited).toMatch(/_italic_/);

  const saveRequest = page.waitForRequest(event => {
    if (event.method() !== 'POST' || new URL(event.url()).pathname !== '/api/commands') return false;
    const command = event.postDataJSON() as { type?: string; issueId?: number };
    return command.type === 'updateIssue' && command.issueId === issue.id;
  });
  await page.keyboard.press('Meta+s');
  const command = (await saveRequest).postDataJSON() as { input: Record<string, unknown> };
  expect(command.input.description).toBe(edited);
  await expect.poll(async () => (await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail).issue.description).toBe(edited);
});

test('Markdown visual editing renders source-backed reference images and preserves unsupported HTML, GFM blocks, nested lists and fenced language', async ({ page, request }) => {
  const source = [
    '## Roundtrip title',
    '',
    'A paragraph to edit.',
    '',
    'Paste target.',
    '',
    '- Parent',
    '  - Nested child',
    '',
    '| Field | Value |',
    '| --- | --- |',
    '| Status | Ready |',
    '',
    '- [ ] Preserved task item',
    '',
    '```typescript',
    'const answer: number = 42;',
    '```',
    '',
    '<span data-redmine="opaque">Keep this exact markup</span>',
    '',
    '![Reference diagram][diagram] and [Reference guide][guide].',
    '',
    '[diagram]: https://assets.example.test/diagram.png "Diagram source"',
    '[guide]: https://docs.example.test/guide "Guide source"',
  ].join('\n');
  const { issue } = await makeIssue(request, source);
  await routeIssueDetail(page, issue, detail => ({ ...detail, textFormat: 'markdown' }));
  let diagramRequests = 0;
  let allowDiagramSuccess = false;
  await page.route('https://assets.example.test/**', route => {
    if (!new URL(route.request().url()).pathname.endsWith('/diagram.png')) return route.fulfill({ status: 404, contentType: 'image/png', body: '' });
    diagramRequests += 1;
    return allowDiagramSuccess
      ? route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
      : route.fulfill({ status: 404, contentType: 'image/png', body: '' });
  });
  await openIssue(page, issue);

  const dialog = page.getByTestId('issue-dialog');
  const preview = dialog.locator('.description-preview');
  await expect(preview.locator('h2')).toHaveText('Roundtrip title');
  const failedDiagram = preview.locator('.rich-image-failed');
  await expect(failedDiagram).toBeVisible();
  const requestsBeforeRetry = diagramRequests;
  allowDiagramSuccess = true;
  await failedDiagram.getByRole('button', { name: 'Try again' }).click();
  await expect(preview.locator('.rich-image-link img[alt="Reference diagram"]')).toBeVisible();
  expect(diagramRequests).toBeGreaterThan(requestsBeforeRetry);
  await preview.getByText('A paragraph to edit.', { exact: true }).click();
  const editor = visualEditor(page, 'issue-description-editor');
  await expect(editor).toBeVisible();
  const paragraph = editor.getByText('A paragraph to edit.', { exact: true });
  const paragraphEnd = await textBoundaryPoint(paragraph, 'A paragraph to edit.');
  await expect(page.getByTestId('issue-description-editor').locator('xpath=ancestor::label')).toHaveCount(0);
  await recordBoldActivations(page, 'issue-description-editor');
  await page.mouse.click(paragraphEnd.end.x, paragraphEnd.end.y);
  await expectNoBoldActivation(page);
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection();
    return selection?.anchorNode?.textContent === 'A paragraph to edit.'
      && selection.anchorOffset === 'A paragraph to edit.'.length
      && selection.isCollapsed;
  })).toBe(true);
  await page.keyboard.type(' changed');
  await expect(editor.getByText('A paragraph to edit. changed', { exact: true })).toBeVisible();
  const sourceImage = editor.locator('[data-redmine-source-image="true"] img[alt="Reference diagram"]');
  await sourceImage.scrollIntoViewIfNeeded();
  await expect(sourceImage).toBeVisible();
  await expect(sourceImage).toHaveAttribute('src', 'https://assets.example.test/diagram.png');
  const pasteParagraph = editor.getByText('Paste target.', { exact: true });
  const pasteEnd = await textBoundaryPoint(pasteParagraph, 'Paste target.');
  await page.mouse.click(pasteEnd.end.x, pasteEnd.end.y);
  await editor.evaluate(editable => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/html', '<p>Pasted <strong>safe</strong> text</p><img src="x" onerror="window.round5PasteXss = true"><script>window.round5PasteXss = true</script>');
    clipboard.setData('text/plain', 'Pasted safe text');
    // Keep ProseMirror's own selection; replacing it through a DOM Range does not update editor.state.selection.
    editable.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(editor).toContainText('Pasted safe text');
  const unsafeNodes = await editor.locator('img[src="x"], script, [onerror]').evaluateAll(elements => elements.map(element => ({
    tag: element.tagName, html: element.outerHTML.slice(0, 240),
  })));
  expect(unsafeNodes).toEqual([]);
  await expect(editor.locator('[data-redmine-source-image="true"]')).toHaveCount(1);
  await dialog.getByTestId('issue-description-editor').getByTestId('issue-description-editor-source-toggle').click();
  const edited = await page.getByTestId('issue-description-editor-source').inputValue();

  expect(edited).toContain('| Field | Value |\n| --- | --- |\n| Status | Ready |');
  expect(edited).toContain('- [ ] Preserved task item');
  expect(edited).toContain('  - Nested child');
  expect(edited).toContain('```typescript\nconst answer: number = 42;\n```');
  expect(edited).toContain('<span data-redmine="opaque">Keep this exact markup</span>');
  expect(edited).toContain('![Reference diagram][diagram] and [Reference guide][guide].');
  expect(edited).toContain('[diagram]: https://assets.example.test/diagram.png "Diagram source"');
  expect(edited).toContain('[guide]: https://docs.example.test/guide "Guide source"');
  expect(edited).toContain('A paragraph to edit. changed');
  expect(edited).toContain('Paste target.');
  expect(edited).toContain('Pasted **safe** text');
  expect(edited).not.toContain('round5PasteXss');
});

test('CommonMark preview highlights safe raw code and resolves only the current issue attachment', async ({ page, request }) => {
  const { boot, issue } = await makeIssue(request);
  const attachmentId = 820_410;
  const attachment: Attachment = {
    id: attachmentId, filename: 'chart.png', url: `${boot.redmineUrl.replace(/\/+$/, '')}/attachments/download/${attachmentId}/chart.png`,
    size: tinyPng.length, contentType: 'image/png',
  };
  const imageSource = attachment.url;
  const updated = await request.post('/api/commands', { data: {
    type: 'updateIssue', issueId: issue.id, input: { description: [
    '<pre><code class="language-ruby">puts \'safe &lt; value\'</code></pre>',
    '',
    `![Issue chart](${imageSource})`,
    '',
    '<script>window.round5RawHtmlXss = true</script>',
    '<img src="x" onerror="window.round5RawHtmlXss = true">',
    ].join('\n') },
  } });
  expect(updated.ok()).toBe(true);
  await routeIssueDetail(page, issue, detail => ({ ...detail, textFormat: 'common_mark', issue: { ...detail.issue, attachments: [attachment] } }));
  let attachmentReads = 0;
  await page.route(url => url.pathname === `/api/issues/${issue.id}/attachments/${attachmentId}/content`, async route => {
    attachmentReads += 1;
    await route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng });
  });
  await openIssue(page, issue);

  const preview = page.getByTestId('issue-dialog').getByTestId('issue-description-preview');
  const code = preview.locator('pre code');
  await expect(code).toHaveClass(/language-ruby/);
  await expect(code).toHaveClass(/hljs/);
  await expect(code).toContainText("puts 'safe < value'");
  const image = preview.locator('.rich-image-link img[alt="Issue chart"]');
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', `/api/issues/${issue.id}/attachments/${attachmentId}/content`);
  await expect(image.locator('xpath=ancestor::a')).toHaveAttribute('href', `/api/issues/${issue.id}/attachments/${attachmentId}/content`);
  await expect(preview.locator('script, [onerror]')).toHaveCount(0);
  expect(attachmentReads).toBe(1);
});

test('a failed image resets when an open preview receives a different source', async ({ page, request }) => {
  const failedUrl = 'https://assets.example.test/round5-failed.png';
  const recoveredUrl = 'https://assets.example.test/round5-recovered.png';
  const { issue } = await makeIssue(request, `![Retryable image](${failedUrl})\n\nKeep this preview open.`);
  let detailReads = 0;
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async route => {
    detailReads += 1;
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    await route.fulfill({ response, json: { ...detail, textFormat: 'markdown' } });
  });
  await page.route('https://assets.example.test/**', route => {
    const url = new URL(route.request().url());
    return url.href === failedUrl
      ? route.fulfill({ status: 404, contentType: 'image/png', body: '' })
      : route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng });
  });
  await openIssue(page, issue);

  const preview = page.getByTestId('issue-dialog').getByTestId('issue-description-preview');
  await expect(preview.locator('.rich-image-failed')).toBeVisible();
  const readsBeforeUpdate = detailReads;
  const updatedDescription = `![Retryable image](${recoveredUrl})\n\nKeep this preview open.`;
  const response = await request.post('/api/commands', { data: {
    type: 'updateIssue', issueId: issue.id, input: { description: updatedDescription },
  } });
  expect(response.ok()).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail).issue.description).toBe(updatedDescription);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => detailReads).toBeGreaterThan(readsBeforeUpdate);
  await expect(preview.locator('.rich-image-link img[alt="Retryable image"]')).toHaveAttribute('src', recoveredUrl);
  await expect(preview.locator('.rich-image-link img[alt="Retryable image"]')).toBeVisible();
  await expect(preview.locator('.rich-image-failed')).toHaveCount(0);
});

test('comment mentions are limited to the current project and submit the Redmine token', async ({ page, request }) => {
  const { issue } = await makeIssue(request);
  await routeIssueDetail(page, issue, detail => ({ ...detail, textFormat: 'markdown' }));
  const projectMember: Person = { id: 820_001, name: 'Project Member', login: 'project.member', mentionToken: '@project.member' };
  const outsideProject: Person = { id: 820_002, name: 'Other Project Member', login: 'other.member', mentionToken: '@other.member' };
  const requestedPaths: string[] = [];
  await page.route(url => url.pathname.endsWith('/mention-users'), async route => {
    requestedPaths.push(new URL(route.request().url()).pathname);
    const projectId = Number(new URL(route.request().url()).pathname.split('/')[3]);
    await route.fulfill({ json: projectId === issue.projectId ? [projectMember] : [outsideProject] });
  });
  await openIssue(page, issue);

  await page.getByTestId('comment-composer-activate').click();
  const comment = visualEditor(page, 'comment-composer');
  await expect(comment).toBeVisible();
  await expect(page.getByTestId('comment-composer').locator('xpath=ancestor::label')).toHaveCount(0);
  await recordBoldActivations(page, 'comment-composer');
  await comment.click();
  await expectNoBoldActivation(page);
  await comment.fill('Hello @pro');
  const suggestions = page.getByRole('listbox', { name: 'Mention a project member' });
  await expect(suggestions.getByRole('option')).toHaveCount(1);
  await expect(suggestions).toContainText('Project Member');
  await expect(suggestions).not.toContainText('Other Project Member');
  // Cancel the platform's native Enter default: this event represents an IME key used to commit composition.
  const composition = await comment.evaluate(editable => {
    const beforeParagraphs = editable.querySelectorAll('p').length;
    editable.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'p' }));
    const compositionKey = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    Object.defineProperty(compositionKey, 'isComposing', { value: true });
    document.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); }, { once: true });
    editable.dispatchEvent(compositionKey);
    const afterParagraphs = editable.querySelectorAll('p').length;
    editable.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'p' }));
    return { isComposing: compositionKey.isComposing, defaultPrevented: compositionKey.defaultPrevented, beforeParagraphs, afterParagraphs };
  });
  expect(composition).toEqual({ isComposing: true, defaultPrevented: true, beforeParagraphs: 1, afterParagraphs: 1 });
  await expect(suggestions).toBeVisible();
  await expect(comment).toContainText('Hello @pro');
  await expect(comment).not.toContainText('@project.member');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByTestId('comment-composer').getByTestId('comment-composer-source-toggle').click();
  const sourceEditor = page.getByTestId('comment-composer-source');
  await expect(sourceEditor).toHaveValue('Hello @project.member ');

  const sent = page.waitForRequest(event => {
    if (event.method() !== 'POST' || new URL(event.url()).pathname !== '/api/commands') return false;
    return (event.postDataJSON() as { type?: string }).type === 'comment';
  });
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  const command = (await sent).postDataJSON() as { input: { notes: string } };
  expect(command.input.notes).toBe('Hello @project.member');
  expect(requestedPaths.length).toBeGreaterThan(0);
  expect(requestedPaths.every(path => path === `/api/projects/${issue.projectId}/mention-users`)).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail).journals.some(journal => journal.notes === command.input.notes)).toBe(true);
});

test('a missing current assignee stays named and disabled while a colliding group choice keeps its type on save', async ({ page, request }) => {
  const { boot, issue } = await makeIssue(request);
  const initial = await (await request.get(`/api/projects/${issue.projectId}/board`)).json() as BoardData;
  const groupOption = initial.assigneeOptions?.find(option => option.type === 'group');
  expect(groupOption, 'the isolated demo project should expose a real group fixture').toBeTruthy();
  const groupId = groupOption!.id;
  const user = initial.members.find(person => person.id === groupId)!;
  const unavailableId = user.id + 50_000;
  await page.route(url => url.pathname === `/api/projects/${issue.projectId}/board`, async route => {
    const response = await route.fetch();
    const board = await response.json() as BoardData;
    await route.fulfill({ response, json: {
      ...board,
      assigneeOptions: [
        { type: 'user', id: groupId, name: user.name },
        { ...groupOption!, name: 'Release group' },
      ],
    } });
  });
  await routeIssueDetail(page, issue, detail => ({ ...detail, issue: {
    ...detail.issue, assignedToId: unavailableId, assignedToType: 'user', assignedToName: 'Former project member',
  } }));
  await openIssue(page, issue);

  const dialog = page.getByTestId('issue-dialog');
  const assignee = dialog.getByRole('combobox', { name: 'Assignee', exact: true });
  await expect(assignee).toHaveAttribute('title', 'Assignee: Former project member');
  await assignee.click();
  const options = page.getByRole('listbox', { name: 'Assignee' });
  const retained = options.getByRole('option', { name: /Former project member/ });
  await expect(retained).toBeDisabled();
  const group = options.getByRole('option', { name: /Release group/ });
  const requestPayload = page.waitForRequest(event => {
    if (event.method() !== 'POST' || new URL(event.url()).pathname !== '/api/commands') return false;
    const command = event.postDataJSON() as { type?: string; issueId?: number };
    return command.type === 'updateIssue' && command.issueId === issue.id;
  });
  await group.click();
  const payload = (await requestPayload).postDataJSON() as { input: Record<string, unknown> };
  expect(payload.input).toMatchObject({ assignedToId: groupId, assignedToType: 'group' });
  await expect.poll(async () => {
    const saved = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
    return { type: saved.issue.assignedToType, name: saved.issue.assignedToName };
  }).toEqual({ type: 'group', name: groupOption!.name });
});

test('issue creation carries a selected group type through the demo command and stored issue', async ({ page, request }) => {
  const { issue } = await makeIssue(request);
  const board = await (await request.get(`/api/projects/${issue.projectId}/board`)).json() as BoardData;
  const group = board.assigneeOptions?.find(option => option.type === 'group');
  expect(group, 'the isolated demo project should expose a real group fixture').toBeTruthy();
  await page.goto(`/?project=${issue.projectId}`);
  await page.getByTestId('new-issue').click();
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  const subject = `Round five group create ${Date.now()}`;
  await dialog.getByTestId('issue-title').fill(subject);
  const assignee = dialog.getByRole('combobox', { name: 'Assignee', exact: true });
  await assignee.click();
  await page.locator('.picker-popover').last().locator(`[role="option"][data-value="group:${group!.id}"]`).click();

  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/commands');
  await dialog.getByTestId('issue-submit').click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const result = await response.json() as CommandResult;
  expect(result.operation.status).toBe('done');
  expect(result.issue).toMatchObject({ subject, assignedToId: group!.id, assignedToType: 'group', assignedToName: group!.name });
  const detail = await (await request.get(`/api/issues/${result.issue!.id}`)).json() as IssueDetail;
  expect(detail.issue).toMatchObject({ assignedToId: group!.id, assignedToType: 'group', assignedToName: group!.name });
});

test('Textile code toolbar saves one escaped language-tagged Redmine block', async ({ page, request }) => {
  const { issue } = await makeIssue(request);
  await routeIssueDetail(page, issue, detail => ({ ...detail, textFormat: 'textile' }));
  await openIssue(page, issue);

  const dialog = page.getByTestId('issue-dialog');
  const preview = dialog.getByTestId('issue-description-preview');
  await preview.click();
  const root = dialog.getByTestId('issue-description-editor');
  const editor = visualEditor(page, 'issue-description-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await root.getByTestId('issue-description-editor-code-language').selectOption('ruby');
  await page.keyboard.insertText("puts '<unsafe>'");

  const source = await sourceEditor(page, 'issue-description-editor');
  const serialized = await source.inputValue();
  expect(serialized.replace(/\n+$/, '')).toBe('<pre><code class="ruby">\nputs \'&lt;unsafe&gt;\'\n</code></pre>');
  expect(serialized.match(/<pre>/g) ?? []).toHaveLength(1);
  expect(serialized).not.toContain('bc.');
  expect(serialized).not.toContain('```');
  const saveRequest = page.waitForRequest(event => {
    if (event.method() !== 'POST' || new URL(event.url()).pathname !== '/api/commands') return false;
    const command = event.postDataJSON() as { type?: string; issueId?: number };
    return command.type === 'updateIssue' && command.issueId === issue.id;
  });
  await page.keyboard.press('Meta+s');
  const command = (await saveRequest).postDataJSON() as { input: { description: string } };
  expect(command.input.description).toBe(serialized);
  await expect.poll(async () => (await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail).issue.description).toBe(serialized);
  await page.reload();
  const savedPreview = page.getByTestId('issue-dialog').getByTestId('issue-description-preview');
  await expect(savedPreview.locator('pre code')).toHaveClass(/language-ruby/);
  await expect(savedPreview.locator('pre code')).toHaveClass(/hljs/);
});
