import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_PARTS = 16;
const ID = /^web-v8-\d{13}-[a-z0-9]{6}$/;
const media = () => getStore({ name:'cluster-episodes', consistency:'strong' });
const queue = () => getStore({ name:'swarm-queue', consistency:'strong' });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json', 'cache-control':'no-store' } });
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const key = (id, variant, part) => `${id}--${variant}--${part}`;

function equal(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

async function operatorPassword() {
  if (process.env.CLUSTER_WEB_PASSWORD) return process.env.CLUSTER_WEB_PASSWORD;
  try { return await getStore('cluster-config').get('web-password', { type:'text', consistency:'strong' }); }
  catch { return null; }
}

export default async function handler(request) {
  const password = await operatorPassword();
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ') || !equal(authorization.slice(7).trim(), password)) {
    return json(401, { ok:false, error:'unauthorized operator' });
  }
  const params = new URL(request.url).searchParams;
  const id = params.get('id') || '';
  const variant = params.get('variant') || '';
  if (!ID.test(id) || !['master','short'].includes(variant)) return json(400, { ok:false, error:'invalid episode or variant' });
  const store = media();
  const manifestKey = key(id, variant, 'manifest');

  if (request.method === 'POST') {
    const pending = await queue().get(`job--${id}`, { type:'json' });
    if (pending?.type !== 'episode-create' || !pending.target_device_ids?.includes('RenderRig')) {
      return json(409, { ok:false, error:'no pending RenderRig episode job' });
    }
    const total = Number(params.get('total'));
    if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) return json(400, { ok:false, error:'invalid part count' });
    const existing = await store.get(manifestKey, { type:'json' });
    if (existing) return json(409, { ok:false, error:'episode variant already finalized' });

    if (params.get('finalize') === '1') {
      const sha = crypto.createHash('sha256');
      let bytes = 0;
      for (let part = 0; part < total; part++) {
        const chunk = await store.get(key(id, variant, part), { type:'arrayBuffer' });
        if (!chunk) return json(409, { ok:false, error:`missing part ${part}` });
        const buffer = Buffer.from(chunk);
        if (!buffer.length || buffer.length > CHUNK_BYTES) return json(413, { ok:false, error:'invalid chunk size' });
        bytes += buffer.length;
        sha.update(buffer);
      }
      const manifest = { ok:true, id, variant, parts:total, bytes, sha256:sha.digest('hex'), created_at:Date.now() };
      await store.setJSON(manifestKey, manifest);
      return json(200, manifest);
    }

    const part = Number(params.get('part'));
    if (!Number.isInteger(part) || part < 0 || part >= total) return json(400, { ok:false, error:'invalid part' });
    if (!request.headers.get('content-type')?.startsWith('video/mp4')) return json(415, { ok:false, error:'expected video/mp4' });
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > CHUNK_BYTES) return json(413, { ok:false, error:'chunk exceeds 2 MiB' });
    const bytes = Buffer.from(await request.arrayBuffer());
    if (!bytes.length || bytes.length > CHUNK_BYTES) return json(413, { ok:false, error:'chunk exceeds 2 MiB' });
    if (part === 0 && bytes.toString('ascii', 4, 8) !== 'ftyp') return json(415, { ok:false, error:'invalid MP4 header' });
    const hash = digest(bytes);
    if (request.headers.get('x-chunk-sha256') !== hash) return json(422, { ok:false, error:'chunk hash mismatch' });
    await store.set(key(id, variant, part), new Blob([bytes], { type:'video/mp4' }));
    return json(200, { ok:true, part, bytes:bytes.length, sha256:hash });
  }

  if (request.method === 'GET') {
    const manifest = await store.get(manifestKey, { type:'json' });
    if (!manifest) return json(404, { ok:false, error:'episode not available' });
    if (params.get('manifest') === '1') return json(200, manifest);
    const part = Number(params.get('part'));
    if (!Number.isInteger(part) || part < 0 || part >= manifest.parts) return json(400, { ok:false, error:'invalid part' });
    const data = await store.get(key(id, variant, part), { type:'arrayBuffer' });
    if (!data) return json(404, { ok:false, error:'part unavailable' });
    return new Response(data, { status:200, headers:{ 'content-type':'video/mp4', 'cache-control':'private, no-store', 'x-content-type-options':'nosniff' } });
  }
  return json(405, { ok:false, error:'method not allowed' });
}
