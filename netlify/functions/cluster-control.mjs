import legacy from './lib/cluster-control.cjs';
import adapter from './lib/control-http-adapter.cjs';

export default adapter.createLegacyFunction(legacy.handler);
