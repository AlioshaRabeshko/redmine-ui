import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { Attachment, Bootstrap, CommandResult, Issue, IssueDetail } from '../src/shared/types.js';
import { sourceEditor } from './helpers/rich-editor.js';

const fixtureImageSize = { width: 96, height: 64 };

function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, 'ascii');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, type, data, checksum]);
}

function createFixturePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 4;
      scanlines[pixel] = 52;
      scanlines[pixel + 1] = 113;
      scanlines[pixel + 2] = 176;
      scanlines[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const fixturePng = createFixturePng(fixtureImageSize.width, fixtureImageSize.height);

async function createIssue(request: APIRequestContext, description: string) {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light', palette: 'blue' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject: `Round five editor corrections ${Date.now()}`, description, statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(response.ok()).toBe(true);
  const issue = (await response.json() as CommandResult).issue!;
  return { boot, issue };
}

async function installDetail(page: Page, issue: Issue, format: string, attachments: Attachment[] = []) {
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    await route.fulfill({ response, json: { ...detail, textFormat: format, issue: { ...detail.issue, attachments } } });
  });
}

async function openIssue(page: Page, issue: Issue) {
  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
}

function visualEditor(page: Page, testId = 'issue-description-editor') {
  return page.getByTestId(`${testId}-visual`).locator('[contenteditable="true"]');
}

async function enterVisualDescriptionEditor(page: Page) {
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-description-edit-toggle').click();
  const editor = visualEditor(page);
  await expect(editor).toBeVisible();
  return editor;
}

function measureContent(root: Element) {
  const bounds = (element: Element | null | undefined) => {
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: rect.top, bottom: rect.bottom, height: rect.height,
      marginTop: Number.parseFloat(style.marginTop) || 0,
      marginBottom: Number.parseFloat(style.marginBottom) || 0,
      lineHeight: Number.parseFloat(style.lineHeight) || 0,
      display: style.display,
      listStyleType: style.listStyleType,
      paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
    };
  };
  const quote = root.querySelector('blockquote');
  const followingParagraph = quote?.nextElementSibling;
  const list = root.querySelector('ul');
  const items = Array.from(list?.querySelectorAll(':scope > li') || []);
  const rule = root.querySelector('hr');
  const lastItem = items.at(-1);
  const linkParagraph = rule?.nextElementSibling;
  return {
    whiteSpace: getComputedStyle(root).whiteSpace,
    quote: bounds(quote), followingParagraph: bounds(followingParagraph),
    list: bounds(list), items: items.map(bounds).filter((item) => item !== undefined), rule: bounds(rule),
    lastItem: bounds(lastItem || null), linkParagraph: bounds(linkParagraph),
  };
}

test('Markdown inline, reference, and raw HTML images render as pixels in WYSIWYG and retain original syntax', async ({ page, request }) => {
  const { boot, issue } = await createIssue(request, 'placeholder');
  const base = boot.redmineUrl.replace(/\/+$/, '');
  const attachmentIds = { inline: 830_101, reference: 830_102, raw: 830_103 };
  const attachments: Attachment[] = [
    { id: attachmentIds.inline, filename: 'inline.png', url: `${base}/attachments/download/${attachmentIds.inline}/inline.png`, size: fixturePng.length, contentType: 'image/png' },
    { id: attachmentIds.reference, filename: 'reference.png', url: `${base}/attachments/download/${attachmentIds.reference}/reference.png`, size: fixturePng.length, contentType: 'image/png' },
    { id: attachmentIds.raw, filename: 'raw.png', url: `${base}/attachments/download/${attachmentIds.raw}/raw.png`, size: fixturePng.length, contentType: 'image/png' },
  ];
  const inlineSource = `![Inline chart](${attachments[0]!.url} "keep inline title")`;
  const referenceSource = '![Reference chart][chart]';
  const referenceDefinition = `[chart]: <${attachments[1]!.url}> "keep reference title"`;
  const rawSource = `<img data-token="keep" alt="Raw chart" src="${attachments[2]!.url}" width="200">`;
  const source = [inlineSource, '', referenceSource, '', referenceDefinition, '', rawSource, '', 'Paragraph beside the images.'].join('\n');
  await installDetail(page, issue, 'common_mark', attachments);

  const attachmentPreviewRequests = new Map<number, number>();
  const editorRequests = new Map<number, number>();
  let editorPhase = false;
  await page.route(url => Object.values(attachmentIds).some(id => url.pathname === `/api/issues/${issue.id}/attachments/${id}/content`), async route => {
    const match = new URL(route.request().url()).pathname.match(/\/attachments\/(\d+)\/content$/);
    const id = Number(match?.[1]);
    if (!editorPhase) {
      attachmentPreviewRequests.set(id, (attachmentPreviewRequests.get(id) || 0) + 1);
      // The sidebar's attachment thumbnails can request these URLs before the
      // editor opens. Abort them so the editor gets a fresh, uncached request.
      return route.abort();
    }
    const attempt = (editorRequests.get(id) || 0) + 1;
    editorRequests.set(id, attempt);
    // Exercise node-local retry only after the source is loaded in the editor.
    if (editorPhase && id === attachmentIds.inline && attempt === 1) {
      return route.fulfill({ status: 404, contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: fixturePng });
  });
  await openIssue(page, issue);

  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog.locator('.attachment-preview')).toHaveCount(3);
  await expect.poll(() => Object.keys(Object.fromEntries(attachmentPreviewRequests)).length).toBe(3);
  for (const id of Object.values(attachmentIds)) expect(attachmentPreviewRequests.get(id)).toBe(1);

  await dialog.getByTestId('issue-description-edit-toggle').click();
  await dialog.getByTestId('issue-description-editor-source-toggle').click();
  const sourceArea = dialog.getByTestId('issue-description-editor-source');
  await sourceArea.fill(source);
  await expect(sourceArea).toHaveValue(source);
  editorPhase = true;
  await dialog.getByTestId('issue-description-editor-visual-toggle').click();

  const editor = visualEditor(page);
  await expect(editor).toBeVisible();
  const imageNodes = editor.locator('[data-redmine-source-image="true"]');
  await expect(imageNodes).toHaveCount(3);
  const inlineNode = editor.locator('[data-redmine-source-image="true"][aria-label="Inline chart"]');
  const inlineFailure = inlineNode.locator('.rich-image-failed');
  await expect(inlineFailure).toBeVisible();
  await inlineFailure.getByRole('button', { name: 'Try again', exact: true }).click();

  for (const [alt, id] of [
    ['Inline chart', attachmentIds.inline],
    ['Reference chart', attachmentIds.reference],
    ['Raw chart', attachmentIds.raw],
  ] as const) {
    const image = editor.locator(`img[alt="${alt}"]`);
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveAttribute('src', `/api/issues/${issue.id}/attachments/${id}/content`);
    await expect.poll(async () => image.evaluate(element => ({ complete: (element as HTMLImageElement).complete, width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }))).toEqual({ complete: true, ...fixtureImageSize });
    const pixels = await image.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, display: getComputedStyle(element).display };
    });
    expect(pixels.width).toBeGreaterThan(0);
    expect(pixels.height).toBeGreaterThan(0);
    expect(pixels.display).not.toBe('none');
  }
  expect(editorRequests.get(attachmentIds.inline)).toBeGreaterThanOrEqual(2);
  expect(editorRequests.get(attachmentIds.reference)).toBe(1);
  expect(editorRequests.get(attachmentIds.raw)).toBe(1);

  const sourceBeforeDelete = await sourceEditor(page, 'issue-description-editor').then(locator => locator.inputValue());
  expect(sourceBeforeDelete).toContain(inlineSource);
  expect(sourceBeforeDelete).toContain(referenceSource);
  expect(sourceBeforeDelete).toContain(referenceDefinition);
  expect(sourceBeforeDelete).toContain(rawSource);
  await page.getByTestId('issue-description-editor-visual-toggle').click();
  await expect(editor).toBeVisible();

  const rawImageNode = editor.locator('[data-redmine-source-image="true"][aria-label="Raw chart"]');
  await rawImageNode.click();
  await expect(rawImageNode).toHaveClass(/is-selected/);
  await page.keyboard.press('Delete');
  await expect(imageNodes).toHaveCount(2);
  await editor.getByText('Paragraph beside the images.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited');

  const savedSource = await sourceEditor(page, 'issue-description-editor').then(locator => locator.inputValue());
  expect(savedSource).toContain(inlineSource);
  expect(savedSource).toContain(referenceSource);
  expect(savedSource).toContain(referenceDefinition);
  expect(savedSource).not.toContain(rawSource);
  expect(savedSource).toContain('Paragraph beside the images. Edited');
});

test('Textile image nodes render through the issue attachment route and preserve their exact source marker', async ({ page, request }) => {
  const { boot, issue } = await createIssue(request, 'placeholder');
  const attachmentId = 830_111;
  const attachment: Attachment = {
    id: attachmentId, filename: 'preview.png', url: `${boot.redmineUrl.replace(/\/+$/, '')}/attachments/download/${attachmentId}/preview.png`,
    size: fixturePng.length, contentType: 'image/png',
  };
  const sourceImage = '!preview.png(Original alt)!';
  const source = `${sourceImage}\n\np. Edit this neighboring paragraph.`;
  const updateResponse = await request.post('/api/commands', { data: { type: 'updateIssue', issueId: issue.id, input: { description: source } } });
  expect(updateResponse.ok()).toBe(true);
  await installDetail(page, issue, 'textile', [attachment]);
  await page.route(url => url.pathname === `/api/issues/${issue.id}/attachments/${attachmentId}/content`, route => route.fulfill({ status: 200, contentType: 'image/png', body: fixturePng }));
  await openIssue(page, issue);

  const editor = await enterVisualDescriptionEditor(page);
  const image = editor.locator('.redmine-source-image img[alt="Original alt"]');
  await image.scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute('src', `/api/issues/${issue.id}/attachments/${attachmentId}/content`);
  await expect.poll(async () => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(fixtureImageSize.width);
  await editor.getByText('Edit this neighboring paragraph.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' changed');
  const savedSource = await sourceEditor(page, 'issue-description-editor').then(locator => locator.inputValue());
  expect(savedSource).toContain(sourceImage);
  expect(savedSource).toContain('Edit this neighboring paragraph. changed');
});

test('quote, list, separator and link geometry stays compact, with markers inside the issue Activity wrapper', async ({ page, request }) => {
  const longQuote = [
    '> We are trying to create a creative through the v2 API and have a problem with the media field. The request rejects a positive companion count even though the main creative itself is valid and ready to be created.',
    '> Can we send zero companions in the first request, create the creative, and then add the companion banners in a separate request after each banner has its own record and identifier?',
    '> The current flow appears to require a count before those companion records exist, so the initial request cannot describe the final state without referring to resources that have not been created yet.',
    '> We need a reliable sequence that keeps the first creative request valid, links each banner afterward, and then updates the final count without duplicating relationships when a request is retried.',
  ].join('\n');
  const uaDescription = 'Опис українською: спочатку створюємо основний креатив, потім додаємо банери окремими запитами та оновлюємо їхню кількість після підтвердження кожного зв’язку.';
  const bullets = [
    '- Create the main creative with only the companion count that matches records already available at the time of this request.',
    '- Add each companion banner in its own request after creation, then revisit the main creative and update the count.',
    '- Make each follow-up request idempotent so a retry cannot create a duplicate companion relationship.',
  ];
  const source = [
    longQuote,
    '',
    uaDescription,
    '',
    ...bullets,
    '',
    '---',
    '',
    'Trello: [implementation issue](https://trello.example.test/card/fixture)',
  ].join('\n');
  const { issue } = await createIssue(request, source);
  await installDetail(page, issue, 'common_mark');
  await openIssue(page, issue);

  const preview = page.getByTestId('issue-dialog').getByTestId('issue-description-preview').locator('.rich-content');
  await expect(preview.locator('blockquote')).toContainText('positive companion count');
  await expect(preview).toContainText(uaDescription);
  const descriptionGeometry = await preview.evaluate(measureContent);
  expect(descriptionGeometry.whiteSpace).toBe('normal');
  const quote = descriptionGeometry.quote!;
  const heading = descriptionGeometry.followingParagraph!;
  expect(heading.top - quote.bottom).toBeLessThanOrEqual(Math.max(36, quote.lineHeight * 2));
  const itemGaps = descriptionGeometry.items.slice(1).map((item, index) => item.top - descriptionGeometry.items[index]!.bottom);
  expect(itemGaps).toHaveLength(2);
  expect(Math.max(...itemGaps)).toBeLessThanOrEqual(28);
  expect(descriptionGeometry.list!.listStyleType).toBe('disc');
  expect(descriptionGeometry.list!.paddingLeft).toBeGreaterThanOrEqual(18);
  const bulletTexts = await preview.locator('ul > li').allTextContents();
  expect(bulletTexts).toEqual(bullets.map(line => line.replace(/^- /, '')));
  expect(longQuote.length).toBeGreaterThanOrEqual(450);
  expect(bulletTexts.join(' ').length).toBeGreaterThanOrEqual(300);
  const separator = descriptionGeometry.rule!;
  const trailingLink = descriptionGeometry.linkParagraph!;
  expect(trailingLink.top - separator.bottom).toBeLessThanOrEqual(36);
  await expect(preview.locator('hr')).toBeVisible();
  await expect(preview.getByRole('link', { name: 'implementation issue' })).toBeVisible();

  await mkdir(join(process.cwd(), 'docs/assets'), { recursive: true });
  const descriptionScreenshot = join(process.cwd(), 'docs/assets/ux-round5-corrections-preview.png');
  await page.screenshot({ path: descriptionScreenshot, animations: 'disabled' });
  await test.info().attach('long-description-preview', { path: descriptionScreenshot, contentType: 'image/png' });
  await test.info().attach('long-description-geometry.json', {
    body: Buffer.from(JSON.stringify({
      viewport: page.viewportSize(), quoteCharacters: longQuote.length, bulletCharacters: bulletTexts.join(' ').length,
      uaDescriptionCharacters: uaDescription.length, geometry: descriptionGeometry,
    }, null, 2)), contentType: 'application/json',
  });

  const notes = source;
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const commentResponse = await request.post('/api/commands', { data: { type: 'comment', issueId: issue.id, input: { notes } } });
  expect(commentResponse.ok()).toBe(true);
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const journal = detail.journals.find(item => item.notes === notes)!;
  expect(journal).toBeTruthy();
  await page.reload();

  const activityItem = page.getByTestId(`journal-item-${journal.id}`);
  await activityItem.scrollIntoViewIfNeeded();
  const activity = activityItem.locator('.activity-body .rich-content');
  await expect(activity.locator('blockquote')).toContainText('positive companion count');
  await expect(activity).toContainText(uaDescription);
  const list = activity.locator('ul');
  await expect(list.locator('li')).toHaveCount(3);
  await expect(activity.locator('hr')).toBeVisible();
  await expect(activity.getByRole('link', { name: 'implementation issue' })).toBeVisible();
  const markerStyle = await list.evaluate(element => {
    const style = getComputedStyle(element);
    const item = getComputedStyle(element.querySelector('li')!);
    const rect = element.getBoundingClientRect();
    return { type: style.listStyleType, position: style.listStylePosition, paddingLeft: Number.parseFloat(style.paddingLeft), itemDisplay: item.display, height: rect.height };
  });
  expect(markerStyle).toMatchObject({ type: 'disc', position: 'outside', itemDisplay: 'list-item' });
  expect(markerStyle.paddingLeft).toBeGreaterThanOrEqual(18);
  expect(markerStyle.height).toBeGreaterThan(0);
  const activityGeometry = await activity.evaluate(measureContent);
  expect(activityGeometry.whiteSpace).toBe('normal');
  expect(activityGeometry.items).toHaveLength(3);
  expect(activityGeometry.list!.listStyleType).toBe('disc');
  expect(activityGeometry.list!.paddingLeft).toBeGreaterThanOrEqual(18);
  expect(activityGeometry.rule).toBeDefined();
  expect(activityGeometry.linkParagraph).toBeDefined();
  const activityItemGaps = await list.locator(':scope > li').evaluateAll(items => items.slice(1).map((item, index) => item.getBoundingClientRect().top - items[index]!.getBoundingClientRect().bottom));
  expect(activityItemGaps).toHaveLength(2);
  expect(Math.max(...activityItemGaps)).toBeLessThanOrEqual(28);
  await activityItem.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'auto' }));
  const activityScreenshot = join(process.cwd(), 'docs/assets/ux-round5-corrections-activity.png');
  await page.screenshot({ path: activityScreenshot, animations: 'disabled' });
  await test.info().attach('long-activity-formatting', { path: activityScreenshot, contentType: 'image/png' });
  await test.info().attach('long-activity-geometry.json', {
    body: Buffer.from(JSON.stringify({
      characters: notes.length, quoteCharacters: longQuote.length, bulletCharacters: bulletTexts.join(' ').length,
      uaDescriptionCharacters: uaDescription.length, geometry: activityGeometry,
    }, null, 2)), contentType: 'application/json',
  });
});
