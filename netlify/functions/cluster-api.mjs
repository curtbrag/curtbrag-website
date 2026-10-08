import { connectLambda, getStore } from '@netlify/blobs';
import { getStore as controlGetStore } from '@netlify/control-blobs';
import legacy from './lib/cluster-api.cjs';
import adapter from './lib/control-http-adapter.cjs';

export default adapter.createLegacyFunction(legacy.createHandler({ connectLambda, getStore, controlGetStore }));
