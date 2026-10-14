import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiFault } from './commands/service.js';
import type { WorkspaceStore } from './db/store.js';

const avatarLimit = 2 * 1024 * 1024;
const avatarVersionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const avatarUrlPattern = /^\/api\/groups\/([1-9]\d*)\/avatar\?v=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const dataUrlSchema = z.object({ dataUrl: z.string().min(1).max(3 * 1024 * 1024) }).strict();
type AvatarContentType = 'image/jpeg' | 'image/png' | 'image/webp';
interface GroupAvatarRecord { version: string; contentType: AvatarContentType; base64: string }

/** Register local-only image routes for Redmine group avatars. Group IDs are validated against
 * cached project group membership and stored under a type-specific key, separate from user IDs. */
export function registerGroupAvatarRoutes(app: FastifyInstance, store: WorkspaceStore): void {
  app.put<{ Params: { id: string } }>('/api/groups/:id/avatar', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const groupId = positiveGroupId(request.params.id);
    if (!(await isKnownGroup(store, groupId))) throw new ApiFault(404, 'GROUP_NOT_FOUND', 'Групу не знайдено.');
    const parsed = dataUrlSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_GROUP_AVATAR', message: 'Очікується data URL зображення JPEG, PNG або WebP.' });
    const decoded = decodeRasterImage(parsed.data.dataUrl);
    if (!decoded) return reply.code(400).send({ code: 'INVALID_GROUP_AVATAR', message: 'Файл має бути справжнім JPEG, PNG або WebP до 2 MiB.' });

    const settings = await store.getSettings();
    const activeOverride = settings.groupAvatarOverrides[String(groupId)];
    const activeVersion = activeOverride?.kind === 'photo' ? avatarVersion(activeOverride.url, groupId) : undefined;
    const version = randomUUID();
    const key = groupAvatarKey(groupId);
    const existing = await store.getValue<GroupAvatarRecord[]>(key) ?? [];
    const activeRecord = activeVersion ? existing.find(item => item.version === activeVersion) : undefined;
    // Retain a small overlap window until settings are patched. This keeps concurrent uploads
    // addressable while a tab is saving its selected version; explicit cleanup removes old bytes.
    const records = [
      { version, contentType: decoded.contentType, base64: decoded.data.toString('base64') },
      ...(activeRecord ? [activeRecord] : []),
      ...existing.filter(item => item.version !== version && item.version !== activeVersion).slice(0, 6),
    ];
    await store.setValue(key, records);
    return { url: `/api/groups/${groupId}/avatar?v=${version}` };
  });

  app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/api/groups/:id/avatar', async (request, reply) => {
    const groupId = positiveGroupId(request.params.id);
    const requestedVersion = request.query.v;
    if (requestedVersion !== undefined && !avatarVersionPattern.test(requestedVersion)) {
      return reply.code(404).send({ code: 'GROUP_AVATAR_NOT_FOUND', message: 'Зображення групи не знайдено.' });
    }
    const records = await store.getValue<GroupAvatarRecord[]>(groupAvatarKey(groupId)) ?? [];
    const selected = requestedVersion === undefined ? records[0] : records.find(item => item.version === requestedVersion);
    if (!selected || !isAvatarContentType(selected.contentType)) {
      return reply.code(404).send({ code: 'GROUP_AVATAR_NOT_FOUND', message: 'Зображення групи не знайдено.' });
    }
    return reply.header('Content-Type', selected.contentType)
      .header('Cache-Control', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .send(Buffer.from(selected.base64, 'base64'));
  });

  app.delete<{ Params: { id: string }; Querystring: { v?: string } }>('/api/groups/:id/avatar', async (request, reply) => {
    const groupId = positiveGroupId(request.params.id);
    if (!(await isKnownGroup(store, groupId))) throw new ApiFault(404, 'GROUP_NOT_FOUND', 'Групу не знайдено.');
    const version = request.query.v;
    if (!version || !avatarVersionPattern.test(version)) {
      return reply.code(400).send({ code: 'INVALID_GROUP_AVATAR_VERSION', message: 'Не вказано коректну версію зображення групи.' });
    }
    const expectedUrl = `/api/groups/${groupId}/avatar?v=${version}`;
    const activeOverride = (await store.getSettings()).groupAvatarOverrides[String(groupId)];
    if (activeOverride?.kind === 'photo' && activeOverride.url === expectedUrl) return { deleted: false };

    const key = groupAvatarKey(groupId);
    const existing = await store.getValue<GroupAvatarRecord[]>(key) ?? [];
    const records = existing.filter(item => item.version !== version);
    if (records.length === existing.length) return { deleted: false };
    await store.setValue(key, records);
    return { deleted: true };
  });
}

function groupAvatarKey(groupId: number): string { return `groupAvatar:${groupId}`; }

function positiveGroupId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiFault(404, 'GROUP_NOT_FOUND', 'Групу не знайдено.');
  return id;
}

async function isKnownGroup(store: WorkspaceStore, groupId: number): Promise<boolean> {
  const groupsByProject = await store.getValue<Record<string, { id: number; name: string }[]>>('projectGroups');
  return Object.values(groupsByProject ?? {}).some(groups => groups.some(group => group.id === groupId));
}

function avatarVersion(url: string, groupId: number): string | undefined {
  const match = avatarUrlPattern.exec(url);
  return match?.[1] === String(groupId) ? match[2] : undefined;
}

function isAvatarContentType(value: string): value is AvatarContentType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}

function decodeRasterImage(dataUrl: string): { contentType: AvatarContentType; data: Buffer } | undefined {
  const maxEncodedLength = Math.ceil(avatarLimit / 3) * 4;
  if (dataUrl.length > maxEncodedLength + 64) return undefined;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) return undefined;
  const contentType = match[1]!.toLowerCase() as AvatarContentType;
  const base64 = match[2]!;
  if (base64.length > maxEncodedLength || base64.length % 4 !== 0) return undefined;
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0 || data.length > avatarLimit || data.toString('base64') !== base64) return undefined;
  const hasJpegSignature = contentType === 'image/jpeg' && data.length >= 3
    && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const hasPngSignature = contentType === 'image/png' && data.length >= 8
    && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const hasWebpSignature = contentType === 'image/webp' && data.length >= 12
    && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!hasJpegSignature && !hasPngSignature && !hasWebpSignature) return undefined;
  return { contentType, data };
}
