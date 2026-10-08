const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const layout = read('src/layouts/Layout.astro');
const landing = read('src/pages/cluster/control.astro');
const css = read('public/styles/cluster-personal-control.css');
const helper = read('public/scripts/cluster-personal-control.js');
const manifest = JSON.parse(read('public/cluster/controller.webmanifest'));
const origin = 'https://curtbrag.com';
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], match[3]]));
const rules = source => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selectors: match[1].trim(), declarations: match[2] }));
const rule = (source, selector) => rules(source).find(item => item.selectors.split(',').map(s => s.trim()).includes(selector));

function mobileRules() {
  const marker = '@media(max-width:700px)';
  const start = css.indexOf(marker);
  assert.ok(start >= 0, 'Controller layout must adapt before narrow Android widths');
  const begin = css.indexOf('{', start);
  let depth = 1, end = begin + 1;
  for (; end < css.length && depth; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}') depth--;
  }
  assert.equal(depth, 0, 'Mobile media rules must be balanced');
  return css.slice(begin + 1, end - 1);
}

test('Layout preserves the released controller additions and updates the command client cache version', () => {
  // Hash of released v70 Layout after CRLF conversion and one optional final newline.
  // Keeping this fixture as a hash makes the test portable outside this workspace.
  const baselineHash = '84f7d6090c2bf12e60e095da0c513c50a81d9650a6980b67821c5b8d4fa5a480';
  let original = layout.replace(/\r\n/g, '\n').replace(/\n$/, '');
  assert.equal(original.split('/scripts/cluster-swarm-live-v8.js?v=71').length, 2);
  original = original.replace('/scripts/cluster-swarm-live-v8.js?v=71', '/scripts/cluster-swarm-live-v8.js?v=70');
  const route = "const clusterControlPage = /^\\/cluster\\/(?:dashboard|control)\\/?$/.test(Astro.url.pathname);";
  for (const addition of [
    route + '\n',
    '    {clusterControlPage && <link rel="manifest" href="/cluster/controller.webmanifest" />}\n' +
      '    {clusterControlPage && <link rel="stylesheet" href="/styles/cluster-personal-control.css?v=2" />}\n\n',
    '\n    {clusterControlPage && <script is:inline src="/scripts/cluster-personal-control.js?v=2"></script>}',
  ]) {
    assert.equal(original.split(addition).length, 2, 'Each authorized addition must appear exactly once');
    original = original.replace(addition, '');
  }
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), baselineHash,
    'Only the controller additions and command client cache version may change');
});

test('Controller assets are scoped to exact landing/dashboard routes and never worker display pages', () => {
  const statement = layout.match(/^const clusterControlPage = .+;$/m)?.[0];
  assert.ok(statement);
  for (const [pathname, expected] of [
    ['/cluster/control/', true], ['/cluster/control', true], ['/cluster/dashboard/', true], ['/cluster/dashboard', true],
    ['/', false], ['/cluster/', false], ['/cluster/display.html', false], ['/cluster/eyecandy.html', false],
    ['/cluster/dashboard/extra', false], ['/cluster/control/extra', false], ['/other/cluster/control/', false],
  ]) {
    assert.equal(vm.runInNewContext(statement + '\nclusterControlPage', { Astro: { url: { pathname } } }), expected, pathname);
  }
  assert.equal((layout.match(/clusterControlPage &&/g) || []).length, 3);
});

test('Manifest installs the existing dashboard with only a non-secret presentation query', () => {
  const start = new URL(manifest.start_url, origin);
  const scope = new URL(manifest.scope, origin);
  const id = new URL(manifest.id, origin);
  for (const url of [start, scope, id]) {
    assert.equal(url.origin, origin);
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, '');
  }
  assert.equal(start.pathname, '/cluster/dashboard/');
  assert.deepEqual([...start.searchParams], [['controller', 'personal']]);
  assert.equal(scope.pathname, '/cluster/'); assert.equal(scope.search, '');
  assert.ok(start.pathname.startsWith(scope.pathname));
  assert.equal(id.search, '');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(manifest.name && manifest.short_name);
  assert.equal(manifest.share_target, undefined);
  assert.equal(manifest.protocol_handlers, undefined);
});

test('Landing primary control link and install hooks agree with the manifest and existing sign-in flow', () => {
  const links = [...landing.matchAll(/<a\b[^>]*>/g)].map(match => attributes(match[0]));
  const primary = links.find(a => (a.class || '').split(/\s+/).includes('controller-primary'));
  assert.ok(primary);
  assert.equal(primary.href, manifest.start_url);
  assert.ok(links.some(a => a.href === '/cluster/dashboard/'));
  assert.match(landing, /id="personal-control-install"\s+type="button"/);
  assert.match(landing, /id="personal-control-install-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(landing, /<details id="personal-control-install-help">/);
  assert.match(landing, /Add to home screen/); assert.match(landing, /Install app/);
  assert.match(landing, /existing dashboard sign-in/);
  assert.doesNotMatch(landing, /<input\b|<iframe\b|<script\b|https?:\/\/[\w.-]+:(?:5037|8022|5555)/i);
});

test('Onboarding distinguishes cloud delivery, connected home devices and browser-local combined reports', () => {
  assert.match(landing, /home Wi-Fi or mobile data/);
  assert.match(landing, /phone sends commands through curtbrag\.com/);
  assert.match(landing, /home PC controller and workers online/);
  assert.match(landing, /Queue results are shared across controllers/);
  assert.match(landing, /Saved combined reports stay in the browser where you create them/);
  assert.match(landing, /use Export to keep a copy/);
  assert.doesNotMatch(landing, /works offline|offline commands|no sign.in required|all screens (?:will|always)|automatically authori[sz]es/i);
});

test('Install vector icon is square, scalable and self-contained; PNG fallback uses its verified real dimensions', () => {
  const vector = manifest.icons.find(icon => icon.type === 'image/svg+xml');
  assert.ok(vector); assert.equal(vector.sizes, 'any'); assert.equal(vector.purpose, 'any');
  assert.equal(new URL(vector.src, origin).origin, origin);
  const svg = read('public' + vector.src);
  const root = attributes(svg.match(/<svg\b[^>]*>/)?.[0] || '');
  assert.equal(root.xmlns, 'http://www.w3.org/2000/svg');
  const width = Number(root.width), height = Number(root.height);
  assert.ok(Number.isInteger(width) && width >= 512); assert.equal(width, height);
  assert.deepEqual(root.viewBox.split(/\s+/).map(Number), [0, 0, width, height]);
  assert.doesNotMatch(svg, /<\s*(?:script|foreignObject|image|iframe|style|text)\b|\s(?:href|xlink:href|on\w+)\s*=|url\s*\(|<!DOCTYPE|<!ENTITY/i);
  const raster = manifest.icons.find(icon => icon.src === '/assets/truck_favicon.png');
  assert.ok(raster); assert.equal(raster.type, 'image/png'); assert.equal(raster.sizes, '64x64');
});

test('Mobile landing collapses its columns and provides minimum touch sizes at 320–390px widths', () => {
  const mobile = mobileRules();
  for (const selector of ['.controller-hero', '.controller-use-cards', '.controller-setup-grid']) {
    assert.match(rule(mobile, selector)?.declarations || '', /grid-template-columns\s*:\s*minmax\(0,1fr\)/);
  }
  assert.match(rule(mobile, '.controller-entry-actions')?.declarations || '', /flex-direction\s*:\s*column/);
  for (const selector of ['.controller-entry-actions a', '.controller-entry-actions button', '#personal-controller-card button']) {
    assert.match(rule(css, selector)?.declarations || '', /min-height\s*:\s*48px/);
  }
  assert.doesNotMatch(mobile, /min-width\s*:\s*(?:[3-9]\d\d|\d{4,})px/);
});

test('Mobile controls undo legacy input overflow and retain readable login and touch targets', () => {
  const mobile = mobileRules();
  const login = rule(mobile, '#loginGate input')?.declarations || '';
  assert.match(login, /min-width\s*:\s*0/); assert.match(login, /font-size\s*:\s*16px\s*!important/);
  assert.match(rule(mobile, '#loginGate [style*="display:flex"]')?.declarations || '', /flex-wrap\s*:\s*wrap/);
  const input = '#panel input:not([type="checkbox"]):not([type="radio"])';
  assert.match(rules(mobile).find(item => item.selectors.includes(input) && /box-sizing/.test(item.declarations))?.declarations || '', /min-width\s*:\s*0\s*!important/);
  for (const selector of ['#panel button', '#panel select']) assert.match(rule(mobile, selector)?.declarations || '', /min-height\s*:\s*44px/);
});

test('Controller shortcut and status classes actually emitted by the helper receive the mobile rules', () => {
  assert.match(helper, /status\.className\s*=\s*['"]controller-status['"]/);
  assert.match(helper, /actions\.className\s*=\s*['"][^'"]*\bcontroller-shortcuts\b[^'"]*['"]/);
  assert.ok(rule(css, '#personal-controller-card .controller-status'));
  const shortcuts = rule(mobileRules(), '#personal-controller-card .controller-shortcuts')?.declarations || '';
  assert.match(shortcuts, /display\s*:\s*grid/);
  assert.match(shortcuts, /grid-template-columns\s*:\s*repeat\(2,minmax\(0,1fr\)\)/);
});
