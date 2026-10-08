const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const test = require("node:test");

const copy = value => JSON.parse(JSON.stringify(value));
const NOW = Date.parse("2026-10-08T20:00:00Z");
const command = (extra = {}) => ({
  id: "control-fixture", type: "mining-status", target: "phones",
  status: "queued", route: "agent", recipient_ids: ["dev253", "dev191"],
  created_at: NOW - 1000, payload: {}, ...extra,
});
const device = (id, hostname) => ({ id, hostname, device_class: "phone" });
function harness(initial = { queue: [], history: [] }, { legacyRuntime = false } = {}) {
  let state = copy(initial), sequence = 0, tail = Promise.resolve();
  const receipts = new Map(), io = [], runtime = [], providerContexts = [], faults = { read: false, write: false, afterCommit: false };
  let runtimeSequence = 0, compatibilityCalls = 0;
  const cells = new Map([
    ["cp-devices:dev253", device("dev253", "phone253")],
    ["cp-devices:dev191", device("dev191", "phone191")],
  ]);
  function getStore(name) {
    const key = typeof name === "string" ? name : name.name;
    return {
      async get(id) {
        io.push({ op: "get", store: key, id });
        if ((key === "cp-commands" || key === "cluster-control") && ["queue", "history"].includes(id))
          throw Error("Independent command arrays must not be read");
        return copy(cells.get(key + ":" + id) ?? null);
      },
      async setJSON(id, value) {
        io.push({ op: "set", store: key, id });
        if ((key === "cp-commands" || key === "cluster-control") && ["queue", "history"].includes(id))
          throw Error("Independent command arrays must not be written");
        cells.set(key + ":" + id, copy(value));
      },
      async list() { return { blobs: [] }; },
    };
  }
  const shared = {
    async snapshot() {
      if (faults.read) throw Object.assign(Error("Snapshot unavailable"), { statusCode: 503 });
      return { ...copy(state), receipt: {} };
    },
    async transact(mutator, { requestId } = {}) {
      const operationId = requestId || 'internal:' + (++sequence);
      const run = tail.then(() => {
        if (faults.read || faults.write) throw Object.assign(Error("Storage unavailable"), { statusCode: 503 });
        if (receipts.has(operationId)) return copy(receipts.get(operationId));
        const draft = copy(state), result = mutator(draft);
        if (!requestId && JSON.stringify(draft) === JSON.stringify(state)) return { ...copy(state), result: copy(result), receipt: {} };
        state = draft;
        const response = { ...copy(state), result: copy(result), receipt: { request_id: requestId } };
        receipts.set(operationId, response);
        if (faults.afterCommit) { faults.afterCommit = false; throw Object.assign(Error("Response lost after commit"), { statusCode: 503 }); }
        return response;
      });
      tail = run.catch(() => {});
      return run;
    },
  };
  const mockCrypto = { ...crypto, randomBytes: size => Buffer.alloc(size, ++sequence) };
  function load(file) {
    const context = {
      exports: {}, process: { env: { CLUSTER_API_KEY: "fixture-agent-key", CLUSTER_WEB_PASSWORD: "fixture-web-password" } },
      Buffer, URL, console: { log() {}, warn() {}, error() {} },
      Date: class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } },
      require(name) {
        if (name === "crypto") return mockCrypto;
        if (name === "@netlify/blobs" || name === "@netlify/control-blobs") return { getStore, connectLambda() {
          compatibilityCalls++;
          const provider = JSON.parse(Buffer.from(context.process.env.NETLIFY_BLOBS_CONTEXT, "base64").toString());
          delete provider.uncachedEdgeURL;
          context.process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify(provider)).toString("base64");
        } };
        if (name === "./control-command-store.cjs") return {
          captureControlContext() {
            const provider = JSON.parse(Buffer.from(context.process.env.NETLIFY_BLOBS_CONTEXT, "base64").toString());
            assert.equal(provider.uncachedEdgeURL, "https://fixture-strong.invalid/", "Capture must precede legacy context replacement");
            return Object.freeze(provider);
          },
          openControlCommandStore(options) {
            assert.equal(options.getStore, getStore);
            assert.ok(options.event && options.event.headers, "Runtime factory needs this request event");
            runtime.push(options.event);
            assert.equal(options.providerContext.uncachedEdgeURL, "https://fixture-strong.invalid/");
            providerContexts.push(options.providerContext);
            return shared;
          },
        };
        throw Error("Unexpected dependency " + name);
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../netlify/functions", file), "utf8"), context, { filename: file });
    return async event => {
      const provider = { siteID: "fixture-site", token: "fixture-runtime-" + (++runtimeSequence), edgeURL: "https://fixture-edge.invalid/", uncachedEdgeURL: "https://fixture-strong.invalid/" };
      context.process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify(provider)).toString("base64");
      const serialized = JSON.stringify(event);
      const result = await context.exports.handler(event);
      assert.equal(JSON.stringify(event), serialized, "Private provider context must not be attached to the caller event");
      return result;
    };
  }
  const agent = load("lib/agent-api.cjs"), legacy = load("lib/cluster-control.cjs");
  async function response(handler, event) {
    const result = await handler(event);
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  }
  return {
    cells, io, runtime, providerContexts, faults, compatibilityCalls: () => compatibilityCalls,
    state: () => copy(state),
    agent(action, { id = "dev253", method = "GET", body = {}, token = "fixture-agent-key" } = {}) {
      return response(agent, { path: "/api/agent/" + action, headers: { "x-device-id": id, "x-agent-token": token }, httpMethod: method, body: JSON.stringify(body), ...(legacyRuntime ? { blobs: "fixture-legacy-context" } : {}) });
    },
    legacy(action = "", { method = "GET", body = {}, key = "fixture-agent-key" } = {}) {
      return response(legacy, { queryStringParameters: { action }, headers: { "x-cluster-key": key }, httpMethod: method,
        body: JSON.stringify({ ...body, ...(action && method === "POST" ? { action } : {}) }), ...(legacyRuntime ? { blobs: "fixture-legacy-context" } : {}) });
    },
  };
}
const complete = (id = "control-fixture", extra = {}) => ({ command_id: id, success: true, exit_code: 0, stdout: "fixture output", stderr: "", ...extra });
const legacyInput = (extra = {}) => ({ password: "fixture-web-password", command: "browse", target: "viki", url: "https://curtbrag.com/", ...extra });
const legacyResult = (id, extra = {}) => ({ id, command: "browse", target: "viki", result: "success", output: "fixture output", ...extra });

test("both consumers capture full runtime context before compatibility reset without exposing it", async () => {
  const h = harness(undefined, { legacyRuntime: true });
  const responses = await Promise.all([h.agent("commands"), h.legacy("poll")]);
  assert.deepEqual(responses.map(result => result.status), [200, 200]);
  assert.equal(h.providerContexts.length, 2);
  assert.notEqual(h.providerContexts[0].token, h.providerContexts[1].token);
  assert.ok(h.providerContexts.every(provider => provider.uncachedEdgeURL === "https://fixture-strong.invalid/"));
  assert.ok(h.runtime.every(event => !JSON.stringify(event).includes("fixture-runtime-")));
  assert.ok(h.runtime.every(event => Object.getOwnPropertySymbols(event).length === 1));
  assert.equal(JSON.stringify(responses).includes("fixture-runtime-"), false);
  assert.equal(JSON.stringify(h.state()).includes("fixture-runtime-"), false);
  assert.equal(h.compatibilityCalls(), 2);
});

test("modern requests preserve normal runtime context through repeated consumer calls", async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    assert.equal((await h.agent("commands")).status, 200);
    assert.equal((await h.legacy("poll")).status, 200);
  }
  assert.equal(h.compatibilityCalls(), 0);
  assert.equal(h.providerContexts.length, 4);
  assert.equal(new Set(h.providerContexts.map(provider => provider.token)).size, 4);
  assert.ok(h.providerContexts.every(provider => provider.uncachedEdgeURL === "https://fixture-strong.invalid/"));
});

test("direct group claim freezes ownership separately for both recipients", async () => {
  const h = harness({ queue: [command()], history: [] });
  const [a, b] = await Promise.all([h.agent("commands"), h.agent("commands", { id: "dev191" })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.commands.length, 1); assert.equal(b.body.commands.length, 1);
  assert.equal(h.state().queue[0].assignments.dev253.acked_by, "dev253");
  assert.equal(h.state().queue[0].assignments.dev191.acked_by, "dev191");
  assert.equal((await h.agent("commands")).body.commands.length, 0);
  assert.deepEqual(h.state().queue[0].recipient_ids, ["dev253", "dev191"]);
});

test("first group completion preserves other recipient; final completion archives once", async () => {
  const h = harness({ queue: [command()], history: [] });
  await h.agent("commands"); await h.agent("commands", { id: "dev191" });
  assert.equal((await h.agent("command-result", { method: "POST", body: complete() })).status, 200);
  assert.equal(h.state().history.length, 0);
  assert.equal(h.state().queue[0].assignments.dev191.status, "running");
  const failed = complete("control-fixture", { success: false, exit_code: 7, stdout: "failure" });
  assert.equal((await h.agent("command-result", { id: "dev191", method: "POST", body: failed })).status, 200);
  assert.equal(h.state().queue.length, 0); assert.equal(h.state().history.length, 1);
  assert.equal(h.state().history[0].status, "failed");
  assert.equal(JSON.parse(h.state().history[0].output).dev191.exit_code, 7);
});

test("unlisted and unclaimed agents cannot complete assigned work", async () => {
  const h = harness({ queue: [command({ recipient_ids: ["dev253"] })], history: [] });
  assert.equal((await h.agent("command-result", { id: "dev191", method: "POST", body: complete() })).status, 409);
  assert.equal((await h.agent("command-result", { method: "POST", body: complete() })).status, 409);
  await h.agent("commands");
  assert.equal((await h.agent("command-result", { id: "dev191", method: "POST", body: complete() })).status, 409);
  assert.equal(h.state().queue.length, 1);
});

test("bridge-only type stays unavailable even with forged agent routing", async () => {
  for (const type of ["phone-return-termux", "fleet-check", "fleet-diagnose", "fleet-discover", "swarm-recover", "swarm-recover-pcs"]) {
    const h = harness({ queue: [command({ type, route: "agent", recipient_ids: ["dev253"] })], history: [] });
    assert.equal((await h.agent("commands")).body.commands.length, 0, type);
    assert.equal((await h.agent("command-result", { method: "POST", body: complete() })).status, 409, type);
    assert.equal(h.state().queue[0].status, "queued", type);
  }
});

test("bridge, legacy, held and unsupported commands never enter direct agent view", async () => {
  const queue = ["bridge", "legacy", "held"].map((route, i) => command({ id: "route-" + i, route }));
  queue.push(command({ id: "unsupported", type: "arbitrary-shell" }));
  const h = harness({ queue, history: [] });
  assert.equal((await h.agent("commands")).body.commands.length, 0);
  assert.equal(h.state().queue.length, 4);
});

test("direct groups without frozen recipients are held and never steal work", async () => {
  const h = harness({ queue: [command({ recipient_ids: undefined })], history: [] });
  assert.equal((await h.agent("commands")).body.commands.length, 0);
  assert.equal(h.state().queue[0].status, "queued");
});

test("explicit single agent route resolves current registered hostname once", async () => {
  const h = harness({ queue: [command({ target: "phone253", recipient_ids: undefined })], history: [] });
  assert.equal((await h.agent("commands")).body.commands.length, 1);
  assert.deepEqual(h.state().queue[0].recipient_ids, ["dev253"]);
  assert.equal((await h.agent("commands", { id: "dev191" })).body.commands.length, 0);
});

test("invalid recipient IDs do not become assignments", async () => {
  const h = harness({ queue: [command({ recipient_ids: ["dev253", "__proto__"] })], history: [] });
  assert.equal((await h.agent("commands")).body.commands.length, 0);
  assert.equal(h.state().queue[0].assignments, undefined);
});

test("typed numeric receipt is mandatory and failure cannot be reported as success", async () => {
  const h = harness({ queue: [command({ recipient_ids: ["dev253"] })], history: [] });
  await h.agent("commands");
  for (const exit_code of [null, "", "0", false, 1.5]) {
    assert.equal((await h.agent("command-result", { method: "POST", body: complete("control-fixture", { exit_code }) })).status, 400);
  }
  assert.equal((await h.agent("command-result", { method: "POST", body: complete("control-fixture", { exit_code: 4 }) })).status, 400);
  assert.equal(h.state().queue.length, 1);
});

test("agent completion retry after ambiguous commit does not archive twice", async () => {
  const h = harness({ queue: [command({ recipient_ids: ["dev253"] })], history: [] });
  await h.agent("commands"); h.faults.afterCommit = true;
  assert.equal((await h.agent("command-result", { method: "POST", body: complete() })).status, 503);
  assert.equal((await h.agent("command-result", { method: "POST", body: complete() })).status, 200);
  assert.equal(h.state().history.length, 1);
  assert.equal((await h.agent("command-result", { method: "POST", body: complete("control-fixture", { stdout: "changed" }) })).status, 409);
});

test("agent snapshot and claim persistence failures return unavailable without success", async () => {
  const h = harness({ queue: [command()], history: [] });
  h.faults.write = true;
  assert.equal((await h.agent("commands")).status, 503);
  assert.equal(h.state().queue[0].assignments, undefined);
  h.faults.write = false; h.faults.read = true;
  assert.equal((await h.agent("heartbeat", { method: "POST" })).status, 503);
});

test("invalid agent auth reaches neither runtime command store nor claims", async () => {
  const h = harness({ queue: [command()], history: [] });
  assert.equal((await h.agent("commands", { token: "wrong-fixture" })).status, 401);
  assert.equal(h.runtime.length, 0);
});

test("legacy enqueue preserves schema in shared authority and never writes copied arrays", async () => {
  const h = harness({ queue: [command({ id: "bridge-existing", route: "bridge" })], history: [] });
  const result = await h.legacy("", { method: "POST", body: legacyInput({ request_id: "fixture-browser-1" }) });
  assert.equal(result.status, 200); assert.equal(result.body.success, true);
  assert.equal(h.state().queue.length, 2);
  const queued = h.state().queue.find(entry => entry.route === "legacy");
  assert.equal(queued.url, "https://curtbrag.com/"); assert.equal(queued.type, "browse");
  assert.equal(queued.created_at, NOW);
  assert.equal(h.io.some(x => ["queue", "history"].includes(x.id)), false);
  const view = await h.legacy();
  assert.equal(view.body.queue.length, 1); assert.equal(view.body.queue[0].command, "browse");
});

test("legacy stable request retry is deduplicated; settings reuse is rejected", async () => {
  const h = harness();
  const request = legacyInput({ request_id: "stable-fixture" });
  const a = await h.legacy("", { method: "POST", body: request });
  const b = await h.legacy("", { method: "POST", body: request });
  assert.equal(a.body.id, b.body.id); assert.equal(h.state().queue.length, 1);
  assert.equal((await h.legacy("", { method: "POST", body: { ...request, url: "https://curtbrag.com/gallery/" } })).status, 409);
});

test("legacy poll exclusively claims rather than removes before delivery", async () => {
  const h = harness();
  const queued = await h.legacy("", { method: "POST", body: legacyInput() });
  const [a, b] = await Promise.all([h.legacy("poll"), h.legacy("poll")]);
  assert.deepEqual([a.body.id, b.body.id].filter(Boolean), [queued.body.id]);
  assert.equal(h.state().queue.length, 1);
  assert.equal(h.state().queue[0].status, "running");
  assert.equal(h.state().queue[0].claimed_by, "legacy-poller");
});

test("legacy poll cannot consume bridge Return or direct-agent work", async () => {
  const h = harness({ queue: [
    command({ id: "return", type: "phone-return-termux", route: "legacy", recipient_ids: undefined }),
    command({ id: "bridge", route: "bridge" }), command({ id: "agent", route: "agent" }),
  ], history: [] });
  assert.deepEqual((await h.legacy("poll")).body, {});
  assert.equal(h.state().queue.length, 3);
});

test("legacy completion requires existing matching owned claim", async () => {
  const h = harness();
  const queued = await h.legacy("", { method: "POST", body: legacyInput() });
  assert.equal((await h.legacy("complete", { method: "POST", body: legacyResult(queued.body.id) })).status, 409);
  await h.legacy("poll");
  assert.equal((await h.legacy("complete", { method: "POST", body: legacyResult(queued.body.id, { target: "node1" }) })).status, 409);
  assert.equal((await h.legacy("complete", { method: "POST", body: legacyResult(queued.body.id) })).status, 200);
  assert.equal(h.state().queue.length, 0); assert.equal(h.state().history.length, 1);
});

test("legacy completion cannot bypass strict bridge Return validation", async () => {
  const h = harness({ queue: [command({ type: "phone-return-termux", route: "bridge", target: "phone253" })], history: [] });
  const result = await h.legacy("complete", { method: "POST", body: legacyResult("control-fixture", { command: "phone-return-termux", target: "phone253" }) });
  assert.equal(result.status, 409); assert.equal(h.state().queue.length, 1);
});

test("legacy completion retry is idempotent and conflicting report is rejected", async () => {
  const h = harness();
  const queued = await h.legacy("", { method: "POST", body: legacyInput() }); await h.legacy("poll");
  h.faults.afterCommit = true;
  assert.equal((await h.legacy("complete", { method: "POST", body: legacyResult(queued.body.id) })).status, 503);
  assert.equal((await h.legacy("complete", { method: "POST", body: legacyResult(queued.body.id) })).status, 200);
  assert.equal((await h.legacy("complete", { method: "POST", body: legacyResult(queued.body.id, { output: "different" }) })).status, 409);
  assert.equal(h.state().history.length, 1);
});

test("legacy flush affects legacy route only and stable retry preserves later enqueue", async () => {
  const h = harness({ queue: [command({ id: "bridge", route: "bridge" }), command({ id: "agent", route: "agent" })], history: [] });
  await h.legacy("", { method: "POST", body: legacyInput({ request_id: "before-flush" }) });
  const body = { password: "fixture-web-password", request_id: "flush-operation" };
  assert.equal((await h.legacy("flush-queue", { method: "POST", body })).body.flushed, 1);
  await h.legacy("", { method: "POST", body: legacyInput({ request_id: "after-flush" }) });
  assert.equal((await h.legacy("flush-queue", { method: "POST", body })).body.flushed, 1);
  assert.equal(h.state().queue.length, 3);
  assert.equal(h.state().history[0].status, "cancelled");
});

test("legacy expired work is archived atomically without claiming another route", async () => {
  const h = harness({ queue: [command({ route: "legacy", recipient_ids: undefined, created_at: NOW - 25 * 3600000 })], history: [] });
  assert.deepEqual((await h.legacy("poll")).body, {});
  assert.equal(h.state().queue.length, 0); assert.equal(h.state().history[0].status, "failed");
});

test("legacy schedules enqueue stable owned work and never return direct execution", async () => {
  const h = harness();
  h.cells.set("cluster-control:schedules", { viki: { enabled: true, rules: [{ time: "20:00", command: "mining-status" }] } });
  const body = { localTime: "20:00", localDate: "2026-10-08" };
  const a = await h.legacy("check-schedule", { method: "POST", body });
  assert.equal(a.status, 200); assert.deepEqual(a.body.commands, []);
  assert.equal(a.body.queued_commands.length, 1); assert.equal(h.state().queue.length, 1);
  assert.deepEqual((await h.legacy("check-schedule", { method: "POST", body })).body.commands, []);
  assert.equal(h.state().queue.length, 1);
  const poll = await h.legacy("poll");
  assert.equal(poll.body.id, a.body.queued_commands[0].id);
  assert.equal(poll.body.command, "mining-status");
});

test("legacy write/read failures are unavailable and independent arrays are untouched", async () => {
  const h = harness(); h.faults.write = true;
  assert.equal((await h.legacy("", { method: "POST", body: legacyInput() })).status, 503);
  assert.equal((await h.legacy("poll")).status, 503); assert.equal(h.state().queue.length, 0);
  h.faults.write = false; h.faults.read = true;
  assert.equal((await h.legacy()).status, 503);
  assert.equal(h.io.some(x => ["queue", "history"].includes(x.id)), false);
});

test("legacy invalid auth never reaches shared command store", async () => {
  const h = harness();
  assert.equal((await h.legacy("poll", { key: "wrong-fixture" })).status, 401);
  assert.equal((await h.legacy("", { method: "POST", body: legacyInput({ password: "wrong-fixture" }) })).status, 401);
  assert.equal(h.runtime.length, 0);
});


const { fixture: casFixture, STATE_KEY: CAS_STATE_KEY } = require("./control-command-api.test.cjs");
const AGENTS = [
  { id: "agent-a", hostname: "phone253", device_class: "phone" },
  { id: "agent-b", hostname: "phone191", device_class: "phone" },
];
const casAgent = (h, id, action = "commands", method = "GET", body = {}) =>
  h.agent(action, method, body, { headers: { "x-device-id": id } });

test("actual CAS: concurrent direct-agent group claims preserve both assignments", async () => {
  const h = casFixture({ devices: AGENTS, queue: [command({ id: "cas-group", recipient_ids: ["agent-a", "agent-b"] })] });
  await h.ready(); h.barrier("read", "cp-commands", CAS_STATE_KEY);
  const [a, b] = await Promise.all([casAgent(h, "agent-a"), casAgent(h, "agent-b")]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.commands.length, 1); assert.equal(b.body.commands.length, 1);
  const state = h.inspect("cp-commands", CAS_STATE_KEY);
  assert.equal(state.queue[0].assignments["agent-a"].status, "running");
  assert.equal(state.queue[0].assignments["agent-b"].status, "running");
  assert.ok(h.writes.some(write => write.status === 412));
  assert.equal((await casAgent(h, "agent-a")).body.commands.length, 0);
});

test("actual CAS: group results require owners and archive once after both finish", async () => {
  const h = casFixture({ devices: AGENTS, queue: [command({ id: "cas-group", recipient_ids: ["agent-a", "agent-b"] })] });
  await casAgent(h, "agent-a"); await casAgent(h, "agent-b");
  const result = complete("cas-group");
  assert.equal((await casAgent(h, "agent-a", "command-result", "POST", result)).status, 200);
  assert.equal(h.inspect("cp-commands", CAS_STATE_KEY).history.length, 0);
  assert.equal((await casAgent(h, "agent-b", "command-result", "POST", result)).status, 200);
  assert.equal((await casAgent(h, "agent-b", "command-result", "POST", result)).status, 200);
  const state = h.inspect("cp-commands", CAS_STATE_KEY);
  assert.equal(state.queue.length, 0); assert.equal(state.history.length, 1);
  assert.equal(state.history[0].status, "succeeded");
  assert.equal((await casAgent(h, "agent-b", "command-result", "POST", complete("cas-group", { stdout: "conflict" }))).status, 409);
});

test("actual CAS: claim storage failure does not release agent work", async () => {
  const h = casFixture({ devices: AGENTS, queue: [command({ id: "cas-group", recipient_ids: ["agent-a", "agent-b"] })] });
  await h.ready(); const before = h.inspect("cp-commands", CAS_STATE_KEY);
  h.fault("write", "cp-commands", CAS_STATE_KEY, "throw", 100);
  assert.equal((await casAgent(h, "agent-a")).status, 503);
  assert.deepEqual(h.inspect("cp-commands", CAS_STATE_KEY), before);
});

test("actual CAS: completion reconciles committed timeout and rejects changed report", async () => {
  const h = casFixture({ devices: AGENTS, queue: [command({ id: "cas-single", recipient_ids: ["agent-a"] })] });
  await casAgent(h, "agent-a");
  h.fault("write", "cp-commands", CAS_STATE_KEY, "after");
  assert.equal((await casAgent(h, "agent-a", "command-result", "POST", complete("cas-single"))).status, 200);
  assert.equal((await casAgent(h, "agent-a", "command-result", "POST", complete("cas-single"))).status, 200);
  assert.equal(h.inspect("cp-commands", CAS_STATE_KEY).history.length, 1);
  assert.equal((await casAgent(h, "agent-a", "command-result", "POST", complete("cas-single", { stdout: "changed" }))).status, 409);
});

test("actual CAS: preview agent and legacy adapters never migrate or write production arrays", async () => {
  const original = command({ id: "production-agent", recipient_ids: ["agent-a"] });
  const h = casFixture({ env: { CONTEXT: "deploy-preview", DEPLOY_ID: "consumer-preview" }, devices: AGENTS, queue: [original] });
  assert.equal((await casAgent(h, "agent-a")).body.commands.length, 0);
  const added = await h.legacy("", "POST", { password: "fixture-operator", command: "browse", target: "viki", url: "https://curtbrag.com/" });
  assert.equal(added.status, 200);
  assert.deepEqual(h.inspect("cp-commands", "queue"), [original]);
  assert.equal(h.inspect("cp-commands", CAS_STATE_KEY), undefined);
  assert.ok(h.writes.filter(write => write.committed).every(write => write.name === "cp-commands-isolated-deploy-preview-consumer-preview"));
});

test("actual CAS: legacy source drift blocks agent and legacy execution", async () => {
  const h = casFixture({ devices: AGENTS, queue: [command({ id: "cas-group", recipient_ids: ["agent-a", "agent-b"] })] });
  await h.ready();
  h.seed("cluster-control", "queue", [{ id: "late-old-writer", command: "debug", target: "viki", queuedAt: new Date(NOW).toISOString() }]);
  assert.equal((await casAgent(h, "agent-a")).status, 503);
  assert.equal((await h.legacy("poll")).status, 503);
  assert.equal(h.inspect("cp-commands", CAS_STATE_KEY).queue[0].assignments, undefined);
});

test("actual CAS: empty agent and legacy polls do not rewrite state or evict retry receipts", async () => {
  const h = casFixture(); await h.ready();
  const count = h.writes.filter(write => write.name === "cp-commands" && write.key === CAS_STATE_KEY).length;
  const before = h.inspect("cp-commands", CAS_STATE_KEY).requestReceipts.length;
  assert.deepEqual((await h.agent("commands")).body.commands, []);
  assert.deepEqual((await h.legacy("poll")).body, {});
  assert.equal(h.writes.filter(write => write.name === "cp-commands" && write.key === CAS_STATE_KEY).length, count);
  assert.equal(h.inspect("cp-commands", CAS_STATE_KEY).requestReceipts.length, before);
});
