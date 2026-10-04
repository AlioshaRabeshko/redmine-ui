/** Use one fresh icon candidate for every count, including zero. Browsers may
 * retain a previous SVG when its link is only pointed back at a cached file. */
export function faviconDataUrl(unread: number): string {
  const count = Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : 0;
  const badge = count ? `<circle cx="49" cy="15" r="13" fill="#df3546"/><text x="49" y="19" font-family="Arial,sans-serif" font-weight="bold" font-size="11" text-anchor="middle" fill="white">${count > 9 ? '9+' : count}</text>` : '';
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="5" y="5" width="54" height="54" rx="17" fill="#4263eb"/><path d="M20 29c0-8 5-13 12-13s12 5 12 13v7l4 6H16l4-6z" fill="white"/><circle cx="32" cy="47" r="3" fill="white"/>${badge}</svg>`)}`;
}

export function updateFavicon(doc: Document, unread: number): void {
  const next = doc.createElement('link');
  next.rel = 'icon';
  next.type = 'image/svg+xml';
  next.setAttribute('sizes', 'any');
  next.href = faviconDataUrl(unread);
  next.dataset.unread = String(Math.max(0, Math.floor(unread || 0)));
  doc.querySelectorAll('link[rel~="icon"]').forEach(icon => icon.remove());
  doc.head.append(next);
}
