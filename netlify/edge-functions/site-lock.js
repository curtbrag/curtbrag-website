import { getStore } from '@netlify/blobs';
import { createSiteLock } from './lib/site-lock-core.js';

export default createSiteLock({
  getPassword: async () => Netlify.env.get('CLUSTER_WEB_PASSWORD') ||
    await getStore('cluster-config', { consistency: 'strong' }).get('web-password', { type: 'text' }),
  getSessions: () => getStore('site-access-sessions', { consistency: 'strong' }),
  getAPIKey: async () => Netlify.env.get('CLUSTER_API_KEY') ||
    await getStore('cluster-config', { consistency: 'strong' }).get('api-key', { type: 'text' }),
});

export const config = { onError: 'fail' };
