'use strict';

// Observes one foreground browser address during an explicit owner session.
// The ADB adapter talks only to the existing localhost server. It cannot start,
// pair, connect, restart or reconfigure a device or an ADB server.
const net = require('node:net');
const crypto = require('node:crypto');

const API = 'https://curtbrag.com/.netlify/functions/cluster-api';
const SWARM_API = 'https://curtbrag.com/api/cluster';
const CONTROLLER_ID = 'curtis-s26-ultra';
const S26_GUID = 'adb-R3GL801BCMK-IEkPhu';
const FLEET = Object.freeze(['phone173', 'phone174', 'phone176', 'phone177', 'phone191', 'phone195', 'phone253', 'phone254', 'Alina', 'Nexus', 'SteamDeck', 'viki', 'RenderRig']);
const BROWSERS = Object.freeze({ BROWSER_CHROME: 'chrome_devtools_remote', BROWSER_SAMSUNG: 'Terrace_devtools_remote' });
const FOREGROUND_COMMAND = 'dumpsys activity activities 2>/dev/null | { top=0; resumed=0; top_browser=BROWSER_OTHER; resumed_browser=BROWSER_OTHER; while IFS= read -r line; do case "$line" in *"topResumedActivity="*|*"topResumedActivity:"*) top=$((top+1)); case "$line" in *" com.android.chrome/"*) top_browser=BROWSER_CHROME;; *" com.sec.android.app.sbrowser/"*) top_browser=BROWSER_SAMSUNG;; esac;; *"mResumedActivity="*|*"mResumedActivity:"*) resumed=$((resumed+1)); case "$line" in *" com.android.chrome/"*) resumed_browser=BROWSER_CHROME;; *" com.sec.android.app.sbrowser/"*) resumed_browser=BROWSER_SAMSUNG;; esac;; esac; done; if [ "$top" -eq 1 ]; then printf "%s\\n" "$top_browser"; elif [ "$top" -eq 0 ] && [ "$resumed" -eq 1 ]; then printf "%s\\n" "$resumed_browser"; else printf "BROWSER_OTHER\\n"; fi; }';
const SENSITIVE_KEY = /^(?:access[_.-]?token|refresh[_.-]?token|id[_.-]?token|tokens?|auth(?:orization)?|password|passwd|secret|session(?:[_.-]?id)?|code|key|api[_.-]?key|credential)$/i;
const PRIVATE_KEYS = new Set(['token', 'tokens', 'auth', 'password', 'accesstoken', 'refreshtoken', 'idtoken', 'authorization', 'secret', 'session', 'sessionid', 'code', 'key', 'apikey', 'credential']);
const SESSION_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeFailure = () => new Error('The requested connection or response could not be verified.');

function validateUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) throw safeFailure();
  let url;
  try { url = new URL(value); } catch (_) { throw safeFailure(); }
  const host = url.hostname.toLowerCase(), labels = host.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 2048 || net.isIP(host) ||
      host.length > 253 || host.endsWith('.') || labels.length < 2 || /^\d+$/.test(labels.at(-1)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /(?:^|\.)(?:localhost|local|localdomain|lan|internal|test|invalid|onion|example|home)$/.test(host)) throw safeFailure();
  let path;
  try { path = decodeURIComponent(url.pathname); } catch (_) { throw safeFailure(); }
  const authPath = /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|oauth|oauth2|auth|authenticate|authentication|authorize|authorization)(?:\/|$)/i;
  if (authPath.test(path) ||
      ((host === 'curtbrag.com' || host === 'www.curtbrag.com') && /^\/cluster\/(?:control|dashboard)(?:\/|$)/i.test(path))) throw safeFailure();
  const rawFragment = url.hash.slice(1);
  let fragmentPath; try { fragmentPath = decodeURIComponent(rawFragment.split('?')[0]); } catch (_) { throw safeFailure(); }
  if (authPath.test(fragmentPath)) throw safeFailure();
  const fragment = rawFragment.replace(/^[^?]*\?/, '');
  for (const params of [url.searchParams, new URLSearchParams(fragment)]) {
    for (const key of params.keys()) if (SENSITIVE_KEY.test(key) || PRIVATE_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ''))) throw safeFailure();
  }
  return url.href;
}

function activeLease(response, now) {
  const follow = response?.follow;
  return response?.ok === true && object(follow) && follow.active === true && follow.controller_id === CONTROLLER_ID &&
    typeof follow.session_id === 'string' && LEASE_ID.test(follow.session_id) && Number.isSafeInteger(follow.expires_at) &&
    (follow.started_at === undefined || (Number.isSafeInteger(follow.started_at) && follow.started_at > 0 && follow.started_at <= now + 5000 &&
      follow.expires_at > follow.started_at && follow.expires_at - follow.started_at <= 3_600_000)) &&
    follow.expires_at > now && follow.expires_at <= now + 3_660_000 ? follow : null;
}

function sameNavigation(expected, actual) {
  if (expected === null) return actual === null;
  if (!object(expected) || !object(actual) || expected.id !== actual.id || !Array.isArray(expected.units) || !Array.isArray(actual.units) || expected.units.length !== actual.units.length) return false;
  const units = new Map(actual.units.map(unit => [unit?.device_id, unit]));
  if (units.size !== actual.units.length) return false;
  return expected.units.every(unit => {
    const acknowledged = units.get(unit.device_id);
    return acknowledged && ['device_id', 'status', 'job_id', 'message'].every(key => acknowledged[key] === unit[key]);
  });
}

function registeredController(response) {
  if (!Array.isArray(response?.controllers)) throw safeFailure();
  const matches = response.controllers.filter(record => record?.controller_id === CONTROLLER_ID);
  if (matches.length !== 1) throw safeFailure();
  const record = matches[0];
  if (record.role !== 'personal-controller' || record.worker_enabled !== false || record.mining_enabled !== false ||
      record.adb_guid !== S26_GUID || record.private_ip !== '192.168.1.237' || !Number.isInteger(record.adb_connect_port) ||
      record.adb_connect_port < 1 || record.adb_connect_port > 65535) throw safeFailure();
  return { guid: record.adb_guid, address: record.private_ip + ':' + record.adb_connect_port };
}

function resolveTransport(devices, controller) {
  if (typeof devices !== 'string' || devices.length > 65536) throw safeFailure();
  const guid = controller.guid + '._adb-tls-connect._tcp';
  const lines = devices.trim().split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/));
  const preferred = lines.filter(line => line[0] === guid);
  const selected = preferred.length ? preferred : lines.filter(line => line[0] === controller.address);
  if (selected.length !== 1 || selected[0][1] !== 'device') throw safeFailure();
  return selected[0][0];
}

// ADB smart sockets use a four-hex-digit byte count, then OKAY/FAIL status.
// Forwarding returns two OKAY statuses and a length-prefixed allocated port.
// See AOSP adb.cpp handle_forward_request and client/commandline.cpp.
class AdbWire {
  constructor(socket, timeoutMs = 5000) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.ended = false; this.failure = null; this.waiter = null;
    this.timer = setTimeout(() => { this.failure = safeFailure(); socket.destroy(); this.wake(); }, timeoutMs);
    socket.on('data', data => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 65536) { this.failure = safeFailure(); socket.destroy(); }
      this.wake();
    });
    socket.on('error', () => { this.failure = safeFailure(); this.wake(); });
    socket.on('end', () => { this.ended = true; this.wake(); });
    socket.on('close', () => { this.ended = true; this.wake(); });
  }
  wake() { if (this.waiter) { const wake = this.waiter; this.waiter = null; wake(); } }
  async read(count) {
    if (!Number.isInteger(count) || count < 0 || count > 65536) throw safeFailure();
    while (this.buffer.length < count) {
      if (this.failure || this.ended) throw safeFailure();
      await new Promise(resolve => { this.waiter = resolve; });
    }
    if (this.failure) throw safeFailure();
    const result = this.buffer.subarray(0, count); this.buffer = this.buffer.subarray(count); return result;
  }
  async status() { if ((await this.read(4)).toString('ascii') !== 'OKAY') throw safeFailure(); }
  async string(max = 65536) {
    const hex = (await this.read(4)).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex) || parseInt(hex, 16) > max) throw safeFailure();
    return (await this.read(parseInt(hex, 16))).toString('utf8');
  }
  async request(service) {
    const bytes = Buffer.from(service, 'utf8');
    if (bytes.length > 4096) throw safeFailure();
    this.socket.write(Buffer.concat([Buffer.from(bytes.length.toString(16).padStart(4, '0')), bytes]));
    await this.status();
  }
  async untilEnd(max = 1024) {
    while (!this.ended && !this.failure) await new Promise(resolve => { this.waiter = resolve; });
    if (this.failure || this.buffer.length > max) throw safeFailure();
    return this.buffer.toString('utf8');
  }
  close() { clearTimeout(this.timer); this.socket.destroy(); this.wake(); }
}

async function openAdbWire({ connect = net.createConnection, timeoutMs = 5000 } = {}) {
  const socket = connect({ host: '127.0.0.1', port: 5037 });
  const wire = new AdbWire(socket, timeoutMs);
  try {
    if (socket.connecting) await new Promise((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', () => reject(safeFailure())); socket.once('close', () => reject(safeFailure()));
    });
    return wire;
  } catch (_) { wire.close(); throw safeFailure(); }
}

class ExistingAdb {
  constructor(options = {}) { this.options = options; this.owned = new Map(); }
  async use(fn) { const wire = await openAdbWire(this.options); try { return await fn(wire); } finally { wire.close(); } }
  async devices() { return this.use(async wire => { await wire.request('host:devices-l'); return wire.string(); }); }
  validSerial(serial) { return serial === S26_GUID + '._adb-tls-connect._tcp' || /^192\.168\.1\.237:[1-9]\d{0,4}$/.test(serial); }
  async foreground(serial) {
    if (!this.validSerial(serial)) throw safeFailure();
    return this.use(async wire => {
      await wire.request('host:transport:' + serial); await wire.request('shell:' + FOREGROUND_COMMAND);
      const value = (await wire.untilEnd(128)).trim();
      if (!['BROWSER_OTHER', ...Object.keys(BROWSERS)].includes(value)) throw safeFailure();
      return value;
    });
  }
  async forward(serial, browser) {
    if (!this.validSerial(serial) || !Object.hasOwn(BROWSERS, browser)) throw safeFailure();
    const port = await this.use(async wire => {
      await wire.request('host-serial:' + serial + ':forward:tcp:0;localabstract:' + BROWSERS[browser]);
      await wire.status(); const text = await wire.string(5);
      if (!/^[1-9]\d{0,4}$/.test(text) || Number(text) > 65535) throw safeFailure();
      return Number(text);
    });
    this.owned.set(port, serial); return port;
  }
  async remove(port) {
    const serial = this.owned.get(port); if (!serial) return;
    await this.use(async wire => { await wire.request('host-serial:' + serial + ':killforward:tcp:' + port); await wire.status(); });
    this.owned.delete(port);
  }
}

function websocketAddress(value, port) {
  let url; try { url = new URL(value); } catch (_) { throw safeFailure(); }
  if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      (url.port && Number(url.port) !== port) || url.username || url.password || url.search || url.hash ||
      !/^\/devtools\/page\/[A-Za-z0-9._:-]{1,180}$/.test(url.pathname)) throw safeFailure();
  return 'ws://127.0.0.1:' + port + url.pathname;
}

async function readJson(url, { fetch: fetcher = globalThis.fetch, signal, timeoutMs = 5000, maxBytes = 262144, headers, method = 'GET', body } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers, method, body, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, redirect: 'error', cache: 'no-store' });
    if (!response.ok || !response.body) throw safeFailure();
    const reader = response.body.getReader(); let chunks = [], count = 0;
    try {
      while (true) { const item = await reader.read(); if (item.done) break; count += item.value.byteLength; if (count > maxBytes) throw safeFailure(); chunks.push(Buffer.from(item.value)); }
    } catch (_) { await reader.cancel().catch(() => {}); throw safeFailure(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) { throw safeFailure(); } finally { clearTimeout(timer); }
}

function evaluateMetadata(url, expression, { WebSocket: Socket = globalThis.WebSocket, signal, timeoutMs = 4000 } = {}) {
  if (!['document.visibilityState', 'location.href'].includes(expression)) return Promise.reject(safeFailure());
  return new Promise((resolve, reject) => {
    const socket = new Socket(url); let finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      try { socket.close(); } catch (_) {}
      error ? reject(safeFailure()) : resolve(value);
    };
    const aborted = () => finish(true), timer = setTimeout(() => finish(true), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) return finish(true);
    socket.addEventListener('open', () => {
      if (!finished) socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, silent: true, throwOnSideEffect: true, timeout: 2500 } }));
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 8192) return finish(true);
      let message; try { message = JSON.parse(event.data); } catch (_) { return finish(true); }
      if (message.id !== 1) return;
      if (message.error || message.result?.exceptionDetails || message.result?.result?.type !== 'string' || typeof message.result.result.value !== 'string') return finish(true);
      const value = message.result.result.value;
      if (expression === 'document.visibilityState' && !['hidden', 'visible'].includes(value)) return finish(true);
      finish(false, value);
    });
    socket.addEventListener('error', () => finish(true)); socket.addEventListener('close', () => { if (!finished) finish(true); });
  });
}

class BrowserSource {
  constructor({ adb = new ExistingAdb(), json = readJson, evaluate = evaluateMetadata, signal } = {}) {
    this.adb = adb; this.json = json; this.evaluate = evaluate; this.signal = signal; this.forwarding = null;
  }
  async cleanup() {
    if (!this.forwarding) return;
    const forwarding = this.forwarding;
    await this.adb.remove(forwarding.port); this.forwarding = null;
  }
  async sample(controller, guard = async () => true) {
    const aborted = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, aborted.signal]) : aborted.signal;
    const check = async () => { if (signal.aborted || !await guard()) { aborted.abort(); throw safeFailure(); } };
    try {
      await check();
      const serial = resolveTransport(await this.adb.devices(), controller), browser = await this.adb.foreground(serial);
      if (!Object.hasOwn(BROWSERS, browser)) { await this.cleanup(); return null; }
      if (this.forwarding && (this.forwarding.serial !== serial || this.forwarding.browser !== browser)) await this.cleanup();
      if (!this.forwarding) this.forwarding = { serial, browser, port: await this.adb.forward(serial, browser) };
      const port = this.forwarding.port;
      await check();
      const raw = await this.json('http://127.0.0.1:' + port + '/json/list', { signal });
      if (!Array.isArray(raw) || raw.length > 128) throw safeFailure();
      // Keep only debugger endpoint strings. Discard URL/title/description and
      // every other target property without logging or retaining them.
      const pages = raw.filter(target => target?.type === 'page').map(target => websocketAddress(target.webSocketDebuggerUrl, port));
      if (new Set(pages).size !== pages.length || pages.length > 32) throw safeFailure();
      raw.length = 0;
      const visible = []; let next = 0;
      // Eight bounded readers avoid a many-tab browser delaying Stop for minutes.
      // Join all readers before removing the forward, including on failure.
      const readers = Array.from({ length: Math.min(8, pages.length) }, async () => {
        try {
          while (next < pages.length) {
            const endpoint = pages[next++]; await check();
            if (await this.evaluate(endpoint, 'document.visibilityState', { signal }) === 'visible') visible.push(endpoint);
          }
        } catch (_) { aborted.abort(); throw safeFailure(); }
      });
      const settled = await Promise.allSettled(readers);
      if (settled.some(item => item.status === 'rejected')) throw safeFailure();
      if (visible.length !== 1) { await this.cleanup(); return null; }
      // Stop or an expired lease during visibility discovery must prevent the
      // actual address read, even when an earlier page was visible.
      await check();
      if (await this.adb.foreground(serial) !== browser) { await this.cleanup(); return null; }
      await check();
      const url = await this.evaluate(visible[0], 'location.href', { signal });
      await check();
      if (await this.evaluate(visible[0], 'document.visibilityState', { signal }) !== 'visible' || await this.adb.foreground(serial) !== browser) { await this.cleanup(); return null; }
      return validateUrl(url);
    } catch (_) { aborted.abort(); await this.cleanup().catch(() => {}); throw safeFailure(); }
  }
}

function browserJob(url, deviceId, jobId) {
  const checked = validateUrl(url);
  if (!FLEET.includes(deviceId) || typeof jobId !== 'string' || !/^[A-Za-z0-9._:-]{1,220}$/.test(jobId)) throw safeFailure();
  const windows = deviceId === 'RenderRig', encoded = Buffer.from(JSON.stringify({ url: checked })).toString('base64');
  const cmd = windows ? JSON.stringify({ url: checked }) : `curl -fLsS --max-time 20 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/f6f01768fdda090564a3f7237d97606a8f01bf4e/scripts/cluster-browser-open.py' -o "$HOME/cluster-browser-open.py" && { if command -v python3 >/dev/null 2>&1; then P=python3; else P=python; fi; "$P" "$HOME/cluster-browser-open.py" --settings-b64 '${encoded}'; }`;
  return { job: { id: jobId, type: windows ? 'website-open' : 'shell', cmd, command: cmd }, target_device_ids: [deviceId] };
}

function freshNodes(snapshot, now) {
  if (!object(snapshot) || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.results)) throw safeFailure();
  const nodes = new Map();
  for (const node of snapshot.nodes) {
    if (!FLEET.includes(node?.id)) continue;
    if (nodes.has(node.id)) throw safeFailure();
    nodes.set(node.id, node);
  }
  return FLEET.map(device_id => {
    const node = nodes.get(device_id);
    const seen = Number(node?.last_seen), online = node?.online === true && Number.isFinite(seen) && seen > 0 && seen <= now + 5000 && now - seen < 90000;
    const busy = node?.busy !== false || !Array.isArray(node?.active_jobs) || node.active_jobs.length > 0;
    const parts = typeof node?.agent_version === 'string' && /^\d+\.\d+\.\d+$/.test(node.agent_version) ? node.agent_version.split('.').map(Number) : [0, 0, 0];
    const currentAgent = parts[0] > 3 || (parts[0] === 3 && (parts[1] > 7 || (parts[1] === 7 && parts[2] >= 2)));
    return { device_id, reason: !online ? 'Worker is offline.' : busy ? 'Worker is busy.' : device_id === 'RenderRig' && !currentAgent ? 'Worker needs a browser launcher update.' : null };
  });
}

function launchResult(result, url) {
  let report; try { report = JSON.parse(result?.stdout); } catch (_) { return 'failed'; }
  if (!object(report) || report.kind !== 'website-browser-open' || report.url !== url || typeof report.launch_requested !== 'boolean' ||
      report.visible_screen_verified !== false || !['launch-requested', 'failed'].includes(report.state)) return 'failed';
  return (result.exit_code === 0 || result.exit_code === '0') && report.launch_requested === true && report.state === 'launch-requested' ? 'launch-requested' : 'failed';
}

function validateConfig(input) {
  if (!object(input) || Object.keys(input).some(key => !['password', 'api_url', 'swarm_api', 'adb_path'].includes(key)) ||
      typeof input.password !== 'string' || !input.password || input.password.length > 256 || /[\u0000-\u001f\u007f]/.test(input.password) ||
      (input.api_url !== undefined && input.api_url !== API) || (input.swarm_api !== undefined && input.swarm_api !== SWARM_API) ||
      typeof input.adb_path !== 'string' || !/^[A-Za-z]:[\\/].+adb\.exe$/i.test(input.adb_path) || /[\u0000-\u001f]/.test(input.adb_path)) throw safeFailure();
  return { ...input, api_url: API, swarm_api: SWARM_API };
}

class PhoneFollower {
  constructor(config, { api, swarm, source, now = Date.now, id = () => crypto.randomUUID(), signal } = {}) {
    this.config = validateConfig(config); this.now = now; this.id = id; this.signal = signal;
    this.api = api || ((action, method = 'GET', body) => this.request(API, action, method, body));
    this.swarm = swarm || ((action, method = 'GET', body) => this.request(SWARM_API, action, method, body));
    this.source = source || new BrowserSource({ signal });
    this.session = null; this.controller = null; this.candidate = null; this.lastUrl = null; this.lastFanout = -Infinity;
    this.navigation = null; this.pending = new Map(); this.stopped = false; this.ticking = false;
  }
  async request(base, action, method, body) {
    try {
      const queue = base === SWARM_API && action === 'queue-status' && method === 'GET';
      const value = await readJson(base + '?action=' + encodeURIComponent(action), {
        method, headers: { Authorization: 'Bearer ' + this.config.password, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: this.signal,
        timeoutMs: queue ? 20000 : 8000, maxBytes: queue ? 16 * 1024 * 1024 : 262144,
      });
      if (!object(value) || value.ok === false) throw safeFailure();
      if (!queue) return value;
      if (!Array.isArray(value.nodes) || !Array.isArray(value.jobs) || !Array.isArray(value.results)) throw safeFailure();
      // Queue history may be large. Retain only current pending receipts and
      // the worker fields needed for an availability decision.
      return {
        nodes: value.nodes.filter(node => FLEET.includes(node?.id)).map(node => ({ id: node.id, online: node.online, last_seen: node.last_seen, busy: node.busy,
          active_jobs: Array.isArray(node.active_jobs) ? (node.active_jobs.length ? ['active-job'] : []) : null, agent_version: node.agent_version })),
        jobs: [],
        results: value.results.filter(result => this.pending.get(result?.device_id) === result?.job_id).map(result => ({ device_id: result.device_id, job_id: result.job_id, exit_code: result.exit_code,
          stdout: typeof result.stdout === 'string' && result.stdout.length <= 8192 ? result.stdout : null })),
      };
    } catch (_) { throw safeFailure(); }
  }
  async fresh(sessionId) {
    if (this.stopped || this.signal?.aborted) return null;
    const lease = activeLease(await this.api('phone-follow-status'), this.now());
    return lease && (!sessionId || lease.session_id === sessionId) ? lease : null;
  }
  async clearLocal() {
    this.session = null; this.controller = null; this.candidate = null; this.lastUrl = null; this.navigation = null;
    await this.source.cleanup();
  }
  async report(status, message, url, navigation) {
    if (this.stopped || this.signal?.aborted) return false;
    const body = { session_id: status === 'off' ? null : this.session, status, message };
    if (status !== 'off') {
      const lease = await this.fresh(this.session); if (!lease) { await this.clearLocal(); return false; }
      // Omission preserves the latest dispatched public link and pending IDs.
      // Stop/expiry clears them on the server; waiting never creates history.
      if (url !== undefined) body.current_url = url;
      if (navigation !== undefined) body.current_navigation = navigation;
    }
    const receipt = await this.api('phone-follow-runner-update', 'POST', body);
    if (receipt?.ok !== true) throw safeFailure();
    if (status === 'off') {
      if (receipt.follow?.active !== false || receipt.follow?.runner?.status !== 'off') throw safeFailure();
    } else {
      const acknowledged = activeLease(receipt, this.now());
      if (!acknowledged || acknowledged.session_id !== body.session_id || acknowledged.runner?.status !== status ||
          (url !== undefined && acknowledged.current_url !== url) ||
          (navigation !== undefined && !sameNavigation(navigation, acknowledged.current_navigation))) throw safeFailure();
    }
    return true;
  }
  reconcile(snapshot) {
    for (const [deviceId, jobId] of this.pending) {
      const found = snapshot.results.filter(result => result?.device_id === deviceId && result.job_id === jobId);
      if (found.length === 1) {
        this.pending.delete(deviceId);
        const unit = this.navigation?.units.find(item => item.device_id === deviceId && item.job_id === jobId);
        if (unit && jobId.startsWith(this.navigation.id + '-')) {
          unit.status = launchResult(found[0], this.lastUrl); unit.message = unit.status === 'launch-requested' ? 'Browser launch requested; screen and page are unverified.' : 'Browser launch failed or returned an invalid receipt.';
        } else if (unit) {
          delete unit.job_id; unit.status = 'skipped'; unit.message = 'The earlier request finished; this link was skipped.';
        }
      }
    }
  }
  async dispatch(url) {
    const sessionId = this.session;
    if (!await this.fresh(sessionId)) { await this.clearLocal(); return; }
    const snapshot = await this.swarm('queue-status'); const units = freshNodes(snapshot, this.now()); this.reconcile(snapshot);
    const navigationId = 'phone-follow-' + this.id();
    if (!SESSION_ID.test(navigationId)) throw safeFailure();
    this.lastUrl = url; this.lastFanout = this.now();
    this.navigation = { id: navigationId, units: units.map(unit => ({ device_id: unit.device_id, status: 'skipped', message: unit.reason || 'Request has not been submitted.' })) };
    for (let index = 0; index < units.length; index++) {
      const unit = units[index], report = this.navigation.units[index];
      if (this.pending.has(unit.device_id)) {
        report.job_id = this.pending.get(unit.device_id); report.status = 'skipped';
        report.message = (unit.reason ? unit.reason + ' ' : '') + 'Earlier browser request still pending; this link was skipped.'; continue;
      }
      if (unit.reason) continue;
      if (!await this.fresh(sessionId)) { await this.clearLocal(); return; }
      if (this.stopped || this.signal?.aborted || this.session !== sessionId) return;
      const jobId = navigationId + '-' + index; report.job_id = jobId;
      // Mark before POST: a lost response must never replay a device action.
      this.pending.set(unit.device_id, jobId); report.status = 'unconfirmed'; report.message = 'Submission could not yet be confirmed.';
      try {
        // The protected state is a durable checkpoint before the device action.
        // A crash or a lost enqueue response cannot turn into a replay on restart.
        if (!await this.report('following', 'Sending the latest link to available devices.', this.lastUrl, this.navigation)) return;
        if (!await this.fresh(sessionId)) { await this.clearLocal(); return; }
        const receipt = await this.swarm('enqueue', 'POST', browserJob(url, unit.device_id, jobId));
        if (receipt?.ok !== true || receipt.job_id !== jobId || receipt.target_count !== 1 || !Array.isArray(receipt.target_device_ids) ||
            receipt.target_device_ids.length !== 1 || receipt.target_device_ids[0] !== unit.device_id ||
            typeof receipt.enqueued !== 'boolean' || receipt.already_present !== !receipt.enqueued) throw safeFailure();
        report.status = 'queued'; report.message = 'Browser launch request queued; screen and page are unverified.';
      } catch (_) {
        report.status = 'unconfirmed'; report.message = 'Submission is unconfirmed; it will not be retried automatically.';
        break;
      }
    }
    await this.report('following', 'Following the visible browser address. Queued requests may finish after Stop.', this.lastUrl, this.navigation);
  }
  async tick() {
    if (this.ticking || this.stopped || this.signal?.aborted) return;
    this.ticking = true;
    try {
      const response = await this.api('phone-follow-status'), lease = activeLease(response, this.now());
      if (!lease) {
        await this.clearLocal();
        // Invalid or expired active responses fail closed; do not overwrite the
        // server session with an invented off receipt.
        if (response?.ok === true && response.follow?.active === false) await this.report('off', 'Following is off. No phone address is being read.');
        return;
      }
      if (this.session !== lease.session_id) {
        await this.clearLocal(); this.session = lease.session_id;
        this.controller = registeredController(await this.api('personal-controllers'));
        // A runner restart must not replay the navigation already recorded by
        // this same session, even when the original POST response was lost.
        if (typeof lease.current_url === 'string') {
          this.lastUrl = validateUrl(lease.current_url);
          if (object(lease.current_navigation) && Array.isArray(lease.current_navigation.units)) {
            this.navigation = structuredClone(lease.current_navigation);
            for (const unit of this.navigation.units) if (FLEET.includes(unit.device_id) && typeof unit.job_id === 'string' && ['queued', 'unconfirmed', 'skipped'].includes(unit.status)) this.pending.set(unit.device_id, unit.job_id);
          }
        }
      }
      // Registration lookup may take time; recheck before any source capture.
      if (!await this.fresh(this.session)) { await this.clearLocal(); return; }
      const snapshot = await this.swarm('queue-status'); freshNodes(snapshot, this.now()); this.reconcile(snapshot);
      const sessionId = this.session;
      const url = await this.source.sample(this.controller, () => this.fresh(sessionId));
      if (!await this.fresh(this.session)) { await this.clearLocal(); return; }
      if (!url) { this.candidate = null; await this.report('waiting', 'Waiting for one visible supported browser page.'); return; }
      const checked = validateUrl(url);
      if (checked === this.lastUrl) { this.candidate = null; await this.report('following', 'Current address is unchanged. No repeated launch was requested.', this.lastUrl, this.navigation); return; }
      if (!this.candidate || this.candidate.url !== checked) this.candidate = { url: checked, at: this.now() };
      else if (this.now() - this.candidate.at >= 4000 && this.now() - this.lastFanout >= 10000) { this.candidate = null; await this.dispatch(checked); return; }
      await this.report('waiting', 'Waiting for a stable public browser address.');
    } catch (_) {
      this.candidate = null;
      await this.source.cleanup().catch(() => {});
      if (this.session) await this.report('unavailable', 'The phone, browser, session or worker availability could not be verified. No automatic retry of a launch is made.').catch(() => {});
    } finally { this.ticking = false; }
  }
  async stop() { this.stopped = true; this.candidate = null; this.lastUrl = null; this.navigation = null; await this.source.cleanup(); }
}

async function readStartup(stream) {
  let text = '';
  for await (const data of stream) { text += data; if (Buffer.byteLength(text) > 16384) throw safeFailure(); }
  try { return validateConfig(JSON.parse(text)); } catch (_) { throw safeFailure(); }
}

function sleepUntilAbort(ms, signal) {
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    signal?.addEventListener('abort', finish, { once: true });
    timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
  });
}

async function main() {
  const config = await readStartup(process.stdin), abort = new AbortController();
  const follower = new PhoneFollower(config, { signal: abort.signal });
  let stopping = false;
  const stop = () => { stopping = true; abort.abort(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    while (!stopping) {
      await follower.tick();
      if (!stopping) await sleepUntilAbort(follower.session ? 5000 : 15000, abort.signal);
    }
  } finally { await follower.stop().catch(() => {}); config.password = ''; follower.config.password = ''; }
}

module.exports = { validateUrl, activeLease, registeredController, resolveTransport, AdbWire, openAdbWire, ExistingAdb, websocketAddress, readJson, evaluateMetadata, BrowserSource, browserJob, freshNodes, launchResult, validateConfig, PhoneFollower, readStartup, sleepUntilAbort, FOREGROUND_COMMAND, FLEET };
if (require.main === module) main().catch(() => { process.stderr.write('Phone following stopped because its configuration or connection could not be verified.\n'); process.exitCode = 1; });
