import type { AppConfig } from '../config.js';

export class ReadOnlyError extends Error {
  readonly code = 'READ_ONLY';
  constructor() { super('Тимчасове обмеження розробки: записи в реальний Redmine наразі вимкнені.'); }
}

export class RedmineConfigError extends Error {
  readonly code = 'REDMINE_CONFIG';
  constructor(message: string) { super(message); }
}

export class RedmineRequestError extends Error {
  readonly code = 'REDMINE_REQUEST_FAILED';
  constructor(message: string, readonly statusCode?: number) { super(message); }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
    const method = String(init.method ?? 'GET').trim().toUpperCase();
    // This check must remain before URL construction and before any fetch call.
    if ((method !== 'GET' && method !== 'HEAD') || init.body !== undefined && init.body !== null) throw new ReadOnlyError();
    const url = this.resolvePath(path);
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.delete('authorization');
      headers.set('X-Redmine-API-Key', this.config.token!);
      response = await this.fetcher(url, {
        ...init,
        method,
        body: undefined,
        headers,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch {
      throw new RedmineRequestError('Не вдалося підключитися до Redmine. Перевірте адресу та мережеве з’єднання.');
    }
    if (!response.ok) throw new RedmineRequestError(`Redmine повернув помилку HTTP ${response.status}.`, response.status);
    if (method === 'HEAD') return undefined as T;
    try {
      return await response.json() as T;
    } catch {
      throw new RedmineRequestError('Redmine повернув відповідь у невідомому форматі.', response.status);
    }
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
