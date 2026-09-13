import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Conversation } from "../src/conversation.js";
import { createServer } from "../src/server.js";
import { StateStore } from "../src/state-store.js";

async function listen(t, conversation, logger = { error() {} }) {
  const server = createServer({ conversation, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("serves the current interface and validates requests without an old API mode", async (t) => {
  const base = await listen(t, { snapshot: async () => ({ messages: [], pending: null, observation: "current" }) });
  const html = await fetch(base).then((response) => response.text());
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const [, id] of script.matchAll(/document.querySelector\("#([\w-]+)"\)/g)) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /<title>AI<\/title>/);
  assert.match(html, /placeholder="話す"/);
  assert.doesNotMatch(html, /id="stop-generation"/);
  const composer = html.split('<form id="composer"')[1].split("</form>")[0];
  assert.equal([...composer.matchAll(/<button\b/g)].length, 1);
  for (const body of [null, [], { text: "old request" }, { id: "first", text: " " }, { id: "invalid:id", text: "Hi" }]) {
    const response = await fetch(base + "/api/messages", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await fetch(base + "/api/messages").then((response) => response.json()), { messages: [], pending: null, observation: "current" });
  assert.deepEqual(await fetch(base + "/api/health").then((response) => response.json()), { ok: true });
});

test("static routes serve only the three public assets", async (t) => {
  const base = await listen(t, {});
  for (const [path, contentType] of [
    ["/", "text/html"],
    ["/index.html", "text/html"],
    ["/app.js", "text/javascript"],
    ["/styles.css", "text/css"],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get("content-type").startsWith(contentType), path);
    await response.body.cancel();
  }

  const packageUrl = new URL("../package.json", import.meta.url);
  for (const path of [
    "/package.json",
    "/../package.json",
    "/%2e%2e/package.json",
    "/..%2fpackage.json",
    "/src/server.js",
    "/constructor",
    "/__proto__",
    `/${packageUrl.href}`,
    `/file:${packageUrl.pathname}`,
    `/file:${packageUrl.pathname.replaceAll("/", "%2f")}`,
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "Not found." }, path);
  }
});

test("an accepted request stays recoverable after the send response is discarded", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-http-"));
  let submits = 0;
  let remoteCompleted = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = { beta: { agents: { sessions: {
    create: async () => ({ id: "sess_test" }),
    stream: () => {
      submits++;
      return Object.assign((async function* () {
        yield { type: "agent.session.turn.item.done", item: { id: "answer", type: "message", role: "assistant", content: [{ type: "output_text", text: "途中" }] } };
        await gate;
        throw new Error("Upstream disconnected");
      })(), { controller: new AbortController() });
    },
    turns: { list: async function* () { if (remoteCompleted) yield { id: "turn_test", status: "completed", subagent_id: null }; } },
    items: { list: async function* () { yield { type: "message", role: "assistant", turn_id: "turn_test", content: [{ type: "output_text", text: "完成しました" }] }; } },
  } } } };
  const store = new StateStore(join(directory, "state.json"));
  const conversation = new Conversation({ client, model: "test-model", store, logger: { error() {} } });
  const base = await listen(t, conversation);
  const send = () => fetch(base + "/api/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "first", text: "こんにちは" }),
  });
  const response = await send();
  assert.equal(response.status, 202);
  assert.match(response.headers.get("content-type"), /application\/json/);
  await response.body.cancel();
  const duplicate = await send().then((value) => value.json());
  assert.equal(duplicate.pending.id, "first");
  assert.ok(submits <= 1);
  remoteCompleted = true;
  release();
  let state;
  for (let i = 0; i < 100; i++) {
    state = await fetch(base + "/api/messages").then((value) => value.json());
    if (!state.pending) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(state.pending, null);
  assert.deepEqual(state.messages.map(({ text }) => text), ["こんにちは", "完成しました"]);
  const duplicateCompleted = await send().then((value) => value.json());
  assert.equal(duplicateCompleted.messages.length, 2);
  assert.equal(submits, 1);
  assert.doesNotMatch(JSON.stringify(state), /sess_test|turn_test|idempotencyKey/);
});

test("retry is a separate explicit operation and server errors do not leak details", async (t) => {
  const retries = [];
  const errors = [];
  const base = await listen(t, {
    snapshot: async () => { throw new Error("Private diagnostic detail"); },
    retry: async (id) => { retries.push(id); return { messages: [], pending: { id } }; },
  }, { error: (error) => errors.push(error) });
  const response = await fetch(base + "/api/retry", { method: "POST", body: JSON.stringify({ id: "first" }) });
  assert.equal(response.status, 202);
  assert.deepEqual(retries, ["first"]);
  const failure = await fetch(base + "/api/messages");
  assert.equal(failure.status, 500);
  assert.doesNotMatch(await failure.text(), /Private diagnostic/);
  assert.equal(errors.length, 1);
});

test("HTTP success reports upstream observation failure separately from generation state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-observation-"));
  const store = new StateStore(join(directory, "state.json"));
  await store.update((state) => ({ ...state, agentSessionId: "sess_test", pendingAgentTurn: {
    id: "first", text: "こんにちは", createdAt: new Date().toISOString(),
    idempotencyKey: "attempt_1", turnId: "turn_test", partialText: "途中",
    status: "processing", error: null, stopRequested: false,
  } }));
  let unavailable = true;
  const sessions = {
    stream: () => assert.fail("Observation must not start another generation"),
    turns: { retrieve: async () => {
      if (unavailable) throw new Error("Private upstream error");
      return { id: "turn_test", status: "in_progress" };
    } },
    items: { list: async function* () {} },
  };
  const conversation = new Conversation({ client: { beta: { agents: { sessions } } }, store, model: "test-model", logger: { error() {} } });
  const base = await listen(t, conversation);
  const response = await fetch(base + "/api/messages");
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.pending.status, "processing");
  assert.equal(snapshot.observation, "unavailable");
  assert.equal(snapshot.pending.partialText, "途中");
  assert.doesNotMatch(JSON.stringify(snapshot), /Private upstream error|sess_test|attempt_1|turn_test/);
  unavailable = false;
  const recovered = await fetch(base + "/api/messages").then((value) => value.json());
  assert.equal(recovered.pending.status, "processing");
  assert.equal(recovered.observation, "current");
});

test("stop accepts a specific request ID without confusing acceptance with completion", async (t) => {
  const stops = [];
  const base = await listen(t, {
    stop: async (id) => {
      stops.push(id);
      return { messages: [], pending: { id, status: "processing", stopRequested: true }, observation: "current" };
    },
  });
  for (const body of [null, {}, { id: "wrong:id" }, { id: 1 }]) {
    const response = await fetch(base + "/api/stop", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  const response = await fetch(base + "/api/stop", { method: "POST", body: JSON.stringify({ id: "first" }) });
  assert.equal(response.status, 202);
  assert.deepEqual(stops, ["first"]);
  const state = await response.json();
  assert.equal(state.pending.status, "processing");
  assert.equal(state.pending.stopRequested, true);
});
