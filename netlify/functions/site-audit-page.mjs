import {getStore} from '@netlify/blobs';
import {createDeploymentHandler} from './lib/site-audit-page.mjs';
import deployment from './lib/control-deployment.cjs';

async function config(envName, key) {
  return process.env[envName] || await getStore('cluster-config').get(key,{type:'text',consistency:'strong'}) || '';
}
export default createDeploymentHandler({context:deployment.context,createSession:(key,value)=>getStore({name:'site-access-sessions',consistency:'strong'}).setJSON(key,value),credentials:async()=>({
  workerKey:await config('CLUSTER_API_KEY','api-key'),
  webPassword:await config('CLUSTER_WEB_PASSWORD','web-password')
})});
