// Netlify build context is captured without any credentials. Runtime previews
// must never choose production command storage because CONTEXT is missing.
const fs = require('node:fs');
const path = require('node:path');
const context = process.env.CONTEXT || null;
const deployID = process.env.DEPLOY_ID || null;
if (context && !['production', 'deploy-preview', 'branch-deploy', 'dev'].includes(context))
  throw new Error('Unknown command storage build context');
if (context && context !== 'production' && !deployID)
  throw new Error('Preview command storage requires a deployment ID');
const filename = path.join(__dirname, '../netlify/functions/lib/control-deployment.cjs');
fs.mkdirSync(path.dirname(filename), { recursive: true });
fs.writeFileSync(filename, 'module.exports = ' + JSON.stringify({ context, deployID }) + ';\n');
