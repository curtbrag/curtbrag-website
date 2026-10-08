import legacy from './lib/agent-api.cjs';
import adapter from './lib/control-http-adapter.cjs';

export default adapter.createLegacyFunction(legacy.handler);
