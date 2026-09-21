import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const uuidPath = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const spa = new RegExp('^/(?:tickets/' + uuidPath + '|conversations/' + uuidPath + ')?$');
const defaultRoot = fileURLToPath(new URL('../../dist/harness-ui/', import.meta.url));
const mime: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
export const isSpaPath = (pathname: string) => spa.test(pathname);

// Validate the original target before URL normalizes traversal segments.
export function requestUrl(target: string, origin: string) {
  if (!target.startsWith('/') || target.startsWith('//')) throw new Error('INVALID_URL');
  // Owned task IDs contain an epoch separator; this is the only encoded path
  // character emitted by the client. Encoded slashes, dots and double encoding stay denied.
  const rawPath = target.split('?')[0];
  const pathname = /^\/api\/tickets\/[^/]+\/tasks\/[^/]+\/stop$/.test(rawPath) ? rawPath.replace(/%3a/gi, ':') : rawPath;
  if (/[\\#\x00-\x20%]/.test(pathname) || pathname.split('/').some(p => p === '.' || p === '..')) throw new Error('INVALID_URL');
  const url = new URL(target, origin); url.pathname = pathname; return url;
}
export class StaticAssets {
  private root: string;
  private allowed = new Set<string>();
  private ready = false;
  constructor(root = defaultRoot) {
    this.root = path.resolve(root);
    try {
      const manifest: unknown = JSON.parse(this.read('.vite/manifest.json').toString('utf8'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return;
      for (const value of Object.values(manifest)) {
        if (!value || typeof value !== 'object') return;
        const v = value as Record<string, unknown>;
        for (const asset of [v.file, ...(Array.isArray(v.css) ? v.css : []), ...(Array.isArray(v.assets) ? v.assets : [])]) {
          if (typeof asset !== 'string' || !/^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|woff2)$/.test(asset)) return;
          this.read(asset); this.allowed.add('/' + asset);
        }
      }
      if (!this.allowed.size) return;
      this.read('index.html'); this.ready = true;
    } catch { /* Missing builds produce 503, never a debug fallback. */ }
  }
  private read(relative: string) {
    const target = path.resolve(this.root, relative), rel = path.relative(this.root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('ASSET_CONTAINMENT');
    for (let p = target; ; p = path.dirname(p)) {
      const s = lstatSync(p);
      if (s.isSymbolicLink() || p === target && (!s.isFile() || s.nlink !== 1)) throw new Error('ASSET_LINK');
      if (p === this.root) break;
    }
    const actual = path.relative(realpathSync.native(this.root), realpathSync.native(target));
    if (actual.startsWith('..') || path.isAbsolute(actual)) throw new Error('ASSET_CONTAINMENT');
    return readFileSync(target);
  }
  get(pathname: string) {
    const index = isSpaPath(pathname);
    if (!index && !this.allowed.has(pathname)) return null;
    const unavailable = () => ({ status: 503, body: Buffer.from('UI_BUILD_UNAVAILABLE'), type: 'text/plain; charset=utf-8', cache: 'no-store', index: false });
    if (!this.ready) return unavailable();
    try { return { status: 200, body: this.read(index ? 'index.html' : pathname.slice(1)),
      type: index ? 'text/html; charset=utf-8' : mime[path.extname(pathname)],
      cache: index ? 'no-store' : 'public, max-age=31536000, immutable', index }; }
    catch { return unavailable(); }
  }
}
