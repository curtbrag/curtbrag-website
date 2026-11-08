import { getStore } from '@netlify/blobs';
import release from './lib/pocket-mate-release.json' with { type: 'json' };

const prefix = '/pocket-mate/files/';
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };

function reply(status, message, extra = {}) {
  return new Response(message, { status, headers: { ...headers, ...extra } });
}

async function* parts(store, keys) {
  for (const key of keys) {
    const stream = await store.get(key, { type: 'stream' });
    if (!stream) throw new Error('Release part missing');
    yield* stream;
  }
}

// Runs after site-lock. Tea's host skips that login and cannot serve these files.
export default async function pocketMateFiles(request) {
  const url = new URL(request.url);
  const filename = url.pathname.slice(prefix.length);
  if (!['curtbrag.com', 'www.curtbrag.com'].includes(url.hostname) ||
      !url.pathname.startsWith(prefix) || !Object.hasOwn(release.files, filename)) {
    return reply(404, 'File not found');
  }

  const file = release.files[filename];
  const storagePrefix = `${file.version ?? release.version}/${file.sha256}/`;
  const keys = file.parts.map((_, index) => storagePrefix + index);
  const store = getStore({ name: 'pocket-mate-releases', consistency: 'strong' });

  if (request.method === 'PUT') {
    if (request.headers.get('origin') !== url.origin) return reply(403, 'Forbidden');
    const part = url.searchParams.get('part');
    const index = part === null ? -1 : Number(part);
    if (String(index) !== part || !Number.isInteger(index) || !keys[index]) {
      return reply(400, 'Invalid release part');
    }
    const expected = Math.min(release.chunkBytes, file.bytes - index * release.chunkBytes);
    if (Number(request.headers.get('content-length')) !== expected) return reply(400, 'Invalid part size');

    const data = await request.arrayBuffer();
    if (data.byteLength !== expected) return reply(400, 'Invalid part size');
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== file.parts[index]) return reply(422, 'Part checksum does not match');

    await store.set(keys[index], new Blob([data]));
    return reply(204, null);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return reply(405, 'Method not allowed', { allow: 'GET, HEAD, PUT' });
  }
  const { blobs } = await store.list({ prefix: storagePrefix });
  const available = new Set(blobs.map(blob => blob.key));
  if (!keys.every(key => available.has(key))) return reply(503, 'Download is being prepared');

  const downloadHeaders = {
    'content-type': file.mediaType ?? (filename.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/zip'),
    'content-disposition': `${file.mediaType ? 'inline' : 'attachment'}; filename="${filename}"`,
    'content-length': String(file.bytes),
  };
  if (request.method === 'HEAD') return reply(200, null, downloadHeaders);

  const chunks = parts(store, keys);
  const body = new ReadableStream({
    async pull(controller) {
      const { done, value } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() { return chunks.return(); },
  });
  return reply(200, body, downloadHeaders);
}
