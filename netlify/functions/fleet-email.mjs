import {getStore} from '@netlify/control-blobs';
import {getStore as configStore} from '@netlify/blobs';
import deployment from './lib/control-deployment.cjs';
import {createHandler} from './lib/fleet-email.mjs';
export default async request => createHandler({
  store:getStore({name:deployment.context==='production'?'fleet-email':'fleet-email-preview-'+(deployment.deployID||'local'),consistency:'strong'}),
  password:async()=>process.env.CLUSTER_WEB_PASSWORD || await configStore('cluster-config').get('web-password',{type:'text'}) || ''
})(request);
