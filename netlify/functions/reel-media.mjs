import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const MAX_BYTES = 4 * 1024 * 1024;
const ID_PATTERN = /^web-v8-\d{13}-[a-z0-9]{6}$/;
const media = () => getStore({ name:'cluster-reels', consistency:'strong' });
const queue = () => getStore({ name:'swarm-queue', consistency:'strong' });

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' },
  });
}

function equal(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

async function operatorPassword() {
  if (process.env.CLUSTER_WEB_PASSWORD) return process.env.CLUSTER_WEB_PASSWORD;
  try { return await getStore('cluster-config').get('web-password', { type:'text', consistency:'strong' }); }
  catch { return null; }
}

export default async function handler(request) {
  const password = await operatorPassword();
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ') || !equal(header.slice(7).trim(), password)) {
    return json(401, { ok:false, error:'unauthorized operator' });
  }

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!ID_PATTERN.test(id)) return json(400, { ok:false, error:'invalid Reel ID' });

  if (request.method === 'POST') {
    const pending = await queue().get(`job--${id}`, { type:'json' });
    if (pending?.type !== 'reel-create' || !pending.target_device_ids?.includes('RenderRig')) {
      return json(409, { ok:false, error:'no pending RenderRig Reel job for this ID' });
    }
    if (!request.headers.get('content-type')?.startsWith('video/mp4')) {
      return json(415, { ok:false, error:'expected video/mp4' });
    }
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return json(413, { ok:false, error:'Reel exceeds 4 MiB' });
    const data = await request.arrayBuffer();
    const bytes = new Uint8Array(data);
    if (!bytes.length || bytes.length > MAX_BYTES) return json(413, { ok:false, error:'Reel must be under 4 MiB' });
    if (Buffer.from(bytes.slice(4, 8)).toString('ascii') !== 'ftyp') {
      return json(415, { ok:false, error:'invalid MP4 header' });
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await media().set(`${id}.mp4`, new Blob([data], { type:'video/mp4' }), {
      metadata:{ sha256, bytes:bytes.length, created_at:Date.now() },
    });
    return json(200, { ok:true, id, bytes:bytes.length, sha256 });
  }

  if (request.method === 'GET') {
    const value = await media().get(`${id}.mp4`, { type:'arrayBuffer' });
    if (!value) return json(404, { ok:false, error:'Reel not found' });
    return new Response(value, {
      status:200,
      headers:{
        'content-type':'video/mp4',
        'content-disposition':`inline; filename="${id}.mp4"`,
        'cache-control':'private, no-store',
        'x-content-type-options':'nosniff',
      },
    });
  }

  return json(405, { ok:false, error:'method not allowed' });
}
