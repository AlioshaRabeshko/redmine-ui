import type { AppConfig } from '../config.js';

export class ReadOnlyError extends Error {
  readonly code = 'READ_ONLY';
  constructor() { super('Запис у Redmine вимкнений. Для його ввімкнення задайте REDMINE_WRITE_ENABLED=true на backend.'); }
}

export class RedmineConfigError extends Error {
  readonly code = 'REDMINE_CONFIG';
  constructor(message: string) { super(message); }
}

export class RedmineRequestError extends Error {
  readonly code = 'REDMINE_REQUEST_FAILED';
  constructor(message: string, readonly statusCode?: number, readonly validationErrors?: string[], readonly outcomeUnknown = false) { super(message); }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type RedmineRasterType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export interface RedmineBinaryResponse { data: Buffer; contentType: RedmineRasterType }
const rasterTypes = new Set<RedmineRasterType>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class RedmineTransport {
  private readonly base: URL;
  constructor(private readonly config: AppConfig, private readonly fetcher: FetchLike = fetch) {
    if (config.configurationError) throw new RedmineConfigError(config.configurationError);
    if (!config.tokenConfigured || !config.token) throw new RedmineConfigError('Додайте REDMINE_API_TOKEN у .env, щоб підключити Redmine.');
    try {
      this.base = new URL(`${config.redmineUrl.replace(/\/+$/, '')}/`);
    } catch {
      throw new RedmineConfigError('REDMINE_URL має бути коректною HTTP(S) адресою.');
    }
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) {
      throw new RedmineConfigError('REDMINE_URL має бути базовою HTTP(S) адресою без облікових даних.');
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.read(path, init);
    if (response.method === 'HEAD' || response.response.status === 204) return undefined as T;
    try {
      return await response.response.json() as T;
    } catch {
      const outcomeUnknown = response.method === 'POST';
      throw new RedmineRequestError(outcomeUnknown
        ? 'Redmine прийняв запис, але повернув відповідь без коректного JSON. Результат невідомий; перевірте стан перед повтором.'
        : 'Redmine повернув відповідь у невідомому форматі.', response.response.status, undefined, outcomeUnknown);
    }
  }

  async requestVoid(path: string, init: RequestInit = {}): Promise<void> {
    await this.read(path, init);
  }

  async requestText(path: string, init: RequestInit = {}, maxBytes = 2 * 1024 * 1024): Promise<string> {
    let currentPath = path;
    const visited = new Set<string>();
    for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
      const response = await this.read(currentPath, init, true);
      if (response.method === 'HEAD') return '';
      if (response.response.status >= 300 && response.response.status < 400) {
        const location = response.response.headers.get('location');
        if (!location || redirectCount === 3) throw new RedmineRequestError('Redmine перенаправив форму поза дозволеною межею.', response.response.status);
        const target = new URL(location, response.response.url || response.url);
        if (target.origin !== this.base.origin || !target.pathname.startsWith(this.base.pathname)) {
          throw new RedmineRequestError('Redmine перенаправив форму на іншу адресу.', 403);
        }
        currentPath = `${target.pathname.slice(this.base.pathname.length)}${target.search}`;
        if (!currentPath || visited.has(currentPath)) throw new RedmineRequestError('Redmine перенаправив форму циклічно.', response.response.status);
        visited.add(currentPath);
        continue;
      }
      try { return (await readBounded(response.response, maxBytes)).toString('utf8'); }
      catch (error) { if (error instanceof RedmineRequestError) throw error; throw new RedmineRequestError('Redmine повернув відповідь у невідомому форматі.', response.response.status); }
    }
    throw new RedmineRequestError('Redmine перенаправив форму поза дозволеною межею.');
  }

  async requestRaster(path: string, maxBytes = 8 * 1024 * 1024): Promise<RedmineBinaryResponse> {
    const { response } = await this.read(path);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new RedmineRequestError('Зображення Redmine перевищує дозволений розмір.', 413);
    }
    const data = await readBounded(response, maxBytes);
    const contentType = sniffRasterType(data);
    if (!contentType) throw new RedmineRequestError('Redmine повернув файл, який не є підтримуваним растровим зображенням.', 415);
    const declaredType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (declaredType && declaredType !== 'application/octet-stream' && rasterTypes.has(declaredType as RedmineRasterType)
      && declaredType !== contentType) {
      throw new RedmineRequestError('Тип файлу Redmine не відповідає його вмісту.', 415);
    }
    return { data, contentType };
  }

  private async read(path: string, init: RequestInit = {}, manualRedirect = false): Promise<{ method: string; response: Response; url: URL }> {
    const method = String(init.method ?? 'GET').trim().toUpperCase();
    // This check must remain before URL construction and before any fetch call.
    const hasBody = init.body !== undefined && init.body !== null;
    const readMethod = method === 'GET' || method === 'HEAD';
    const writeMethod = method === 'POST' || method === 'PUT' || method === 'DELETE';
    if (readMethod ? hasBody : !writeMethod || this.config.writeEnabled !== true) throw new ReadOnlyError();
    if (manualRedirect && !readMethod) throw new ReadOnlyError();
    if (!readMethod && !/\.json(?:\?.*)?$/i.test(path)) {
      throw new RedmineConfigError('Записи Redmine дозволені лише через REST JSON endpoints.');
    }
    const headers = new Headers(init.headers);
    if (method === 'POST' || method === 'PUT') {
      if (typeof init.body !== 'string') throw new RedmineConfigError('Записи в Redmine підтримують лише JSON-тіло.');
      const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType && contentType !== 'application/json') throw new RedmineConfigError('Записи в Redmine підтримують лише application/json.');
      headers.set('Content-Type', 'application/json');
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      } catch {
        throw new RedmineConfigError('Тіло запису Redmine має бути коректним JSON-об’єктом.');
      }
    } else if (method === 'DELETE' && hasBody) {
      throw new RedmineConfigError('DELETE-запити до Redmine мають бути без тіла.');
    }
    const url = this.resolvePath(path);
    let response: Response;
    try {
      headers.delete('authorization');
      headers.set('X-Redmine-API-Key', this.config.token!);
      response = await this.fetcher(url, {
        ...init,
        method,
        body: hasBody ? init.body : undefined,
        headers,
        // Writes never follow redirects: redirecting a POST can duplicate a mutation or expose auth.
        redirect: manualRedirect ? 'manual' : 'error',
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (!readMethod) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new RedmineRequestError(timedOut
          ? 'Час очікування відповіді Redmine минув. Результат запису невідомий; перевірте стан перед повтором.'
          : 'Не вдалося підтвердити відповідь Redmine. Результат запису невідомий; перевірте стан перед повтором.', undefined, undefined, true);
      }
      throw new RedmineRequestError('Не вдалося підключитися до Redmine. Перевірте адресу та мережеве з’єднання.');
    }
    if (!response.ok && !(manualRedirect && response.status >= 300 && response.status < 400)) {
      if (response.status === 422) {
        const validationErrors = await readValidationErrors(response, this.config.token);
        const detail = validationErrors.length ? `: ${validationErrors.join('; ')}` : '.';
        throw new RedmineRequestError(`Redmine відхилив зміни${detail}`, 422, validationErrors, false);
      }
      const redirect = response.status >= 300 && response.status < 400;
      const outcomeUnknown = !readMethod && (redirect || response.status >= 500);
      throw new RedmineRequestError(redirect
        ? 'Redmine намагався перенаправити запис; запит зупинено для безпеки.'
        : `Redmine повернув помилку HTTP ${response.status}.`, response.status, undefined, outcomeUnknown);
    }
    return { method, response, url };
  }

  private resolvePath(path: string): URL {
    if (typeof path !== 'string' || !path || path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes('\\')) {
      throw new RedmineConfigError('Запит Redmine має використовувати відносний шлях API.');
    }
    const segments = path.split(/[?#]/, 1)[0]!.split('/');
    if (segments.some(segment => segment === '..' || segment === '.')) throw new RedmineConfigError('Шлях Redmine виходить за межі API.');
    let url: URL;
    try { url = new URL(path, this.base); }
    catch { throw new RedmineConfigError('Некоректний шлях запиту Redmine.'); }
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) {
      throw new RedmineConfigError('Запит Redmine виходить за межі налаштованого сервера.');
    }
    return url;
  }
}

async function readValidationErrors(response: Response, secret?: string): Promise<string[]> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return [];
  try {
    const bytes = await readBounded(response.clone(), 16 * 1024);
    const parsed = JSON.parse(bytes.toString('utf8')) as { errors?: unknown };
    const values = Array.isArray(parsed.errors) ? parsed.errors : parsed.errors === undefined ? [] : [parsed.errors];
    return values.flatMap(value => {
      if (typeof value !== 'string') return [];
      const message = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!message) return [];
      const redacted = secret ? message.split(secret).join('[redacted]') : message;
      return [redacted.slice(0, 240)];
    }).slice(0, 8);
  } catch {
    return [];
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive safe integer');
  const reader = response.body?.getReader();
  if (!reader) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new RedmineRequestError('Відповідь Redmine перевищує дозволений розмір.', 413);
    return data;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RedmineRequestError('Відповідь Redmine перевищує дозволений розмір.', 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function sniffRasterType(data: Uint8Array): RedmineRasterType | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && String.fromCharCode(...data.subarray(0, 6)).match(/^GIF8[79]a$/)) return 'image/gif';
  if (data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}
