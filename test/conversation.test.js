import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import OpenAI from "openai";
import { Conversation } from "../src/conversation.js";
import { StateStore } from "../src/state-store.js";

const terminal = (status = "completed", id = "turn_1") => ({
  type: `agent.session.turn.${status}`, turn: { id, subagent_id: null, status },
});
const answer = (text, id = "msg_1", phase = "final_answer") => ({
  id, type: "message", role: "assistant", phase, turn_id: "turn_1",
  content: [{ type: "output_text", text }],
});
const itemDone = (text, id, phase) => ({ type: "agent.session.turn.item.done", item: answer(text, id, phase) });

async function setup(events = [itemDone("Hello"), terminal()]) {
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-agent-"));
  const path = join(directory, "state.json");
  const store = new StateStore(path);
  const calls = [];
  const controllers = [];
  const errors = [];
  const sessions = {
    create: async (request) => { calls.push({ create: request }); return { id: "sess_test" }; },
    stream: (id, request, options) => {
      calls.push({ stream: id, ...request, options });
      const controller = new AbortController();
      controllers.push(controller);
      return Object.assign((async function* () { yield* events; })(), { controller });
    },
    turns: { list: async function* () {} },
    items: { list: async function* () {} },
  };
  const config = { client: { beta: { agents: { sessions } } }, model: "test-model", store, logger: { error: (error) => errors.push(error) } };
  const conversation = new Conversation(config);
  async function settled() {
    await until(() => controllers.length > 0 && controllers.every((controller) => controller.signal.aborted));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { conversation, sessions, store, calls, controllers, path, config, settled, errors };
}

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Expected state was not reached");
}

test("accepts durable input before generation and keeps one session", async () => {
  const { conversation, calls, settled, store } = await setup();
  const accepted = await conversation.send({ id: "first", text: "Hello" });
  assert.equal(accepted.pending.text, "Hello");
  assert.equal(accepted.pending.status, "processing");
  assert.equal(accepted.observation, "current");
  assert.equal(accepted.pending.idempotencyKey, undefined);
  assert.equal(accepted.pending.turnId, undefined);
  await settled();
  await conversation.send({ id: "second", text: "Again" });
  await settled();
  assert.equal(calls.filter((call) => call.create).length, 1);
  const streams = calls.filter((call) => call.stream);
  assert.deepEqual(streams.map((call) => call.input), ["Hello", "Again"]);
  assert.notEqual(streams[0].idempotencyKey, streams[1].idempotencyKey);
  assert.equal(streams[0].options.maxRetries, 0);
  assert.equal(streams[0].options.signal, undefined, "Streaming must not have a generation deadline");
  assert.equal((await store.read()).messages.length, 4);
  assert.deepEqual(calls[0].create.agent.multi_agent, { enabled: false });
});

test("combines text parts and excludes commentary and tool output", async () => {
  const { conversation, settled } = await setup([
    itemDone("Hidden progress", "progress", "commentary"),
    { type: "agent.session.turn.item.added", item: answer("Old") },
    { type: "agent.session.turn.output_text.delta", item_id: "msg_1", content_index: 0, delta: " delta" },
    { type: "agent.session.turn.output_text.done", item_id: "msg_1", content_index: 0, text: "First" },
    { type: "agent.session.turn.output_text.done", item_id: "msg_1", content_index: 1, text: " part" },
    { type: "agent.session.turn.item.done", item: { type: "command_execution", output: "Private tool log" } },
    itemDone("Second", "msg_2"), terminal(),
  ]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  assert.equal((await conversation.snapshot()).messages[1].text, "First part\n\nSecond");
});

for (const ending of ["idle", "environment.failed", "requires_action", "eof"]) {
  test(`keeps partial text without treating ${ending} as success or retrying`, async () => {
    const events = [itemDone("Partial")];
    if (ending !== "eof") events.push({ type: `agent.session.${ending}` });
    const { conversation, settled, calls } = await setup(events);
    await conversation.send({ id: "first", text: "Hello" });
    await settled();
    const snapshot = await conversation.snapshot();
    assert.equal(snapshot.pending.partialText, "Partial");
    assert.equal(snapshot.pending.status, "processing");
    assert.equal(snapshot.observation, "unavailable");
    assert.deepEqual(snapshot.messages, []);
    await conversation.send({ id: "first", text: "Hello" });
    await conversation.retry("first");
    await conversation.snapshot();
    assert.equal(calls.filter((call) => call.stream).length, 1);
    await assert.rejects(conversation.send({ id: "second", text: "Different" }), { statusCode: 409 });
  });
}

test("recovers a completed result by checking, without resubmitting input", async () => {
  const { conversation, sessions, settled, calls } = await setup([itemDone("Partial")]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  sessions.turns.list = async function* () { yield { id: "turn_1", status: "completed", subagent_id: null }; };
  sessions.items.list = async function* () {
    yield answer("Hidden", "progress", "commentary");
    yield { ...answer("Old"), turn_id: "old_turn" };
    yield answer("Complete reply");
  };
  const snapshot = await conversation.snapshot();
  assert.equal(snapshot.pending, null);
  assert.equal(snapshot.messages[1].text, "Complete reply");
  assert.equal(snapshot.messages[1].id, "first:reply");
  await conversation.send({ id: "first", text: "Hello" });
  assert.equal((await conversation.snapshot()).messages.length, 2);
  assert.equal(calls.filter((call) => call.stream).length, 1);
});

test("uses the recorded turn ID and retains partial text while remote work runs", async () => {
  const { conversation, sessions, settled, calls } = await setup([terminal("created"), itemDone("Partial")]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  sessions.turns.retrieve = async (id) => {
    assert.equal(id, "turn_1");
    return { id, status: "in_progress" };
  };
  sessions.turns.list = () => assert.fail("A known turn must not be guessed from a list");
  sessions.items.list = async function* () { yield answer("Part"); };
  const running = await conversation.snapshot();
  assert.equal(running.pending.partialText, "Partial");
  assert.equal(running.pending.status, "processing");
  assert.equal(running.observation, "current");
  sessions.turns.retrieve = async () => { throw new Error("Offline"); };
  const snapshot = await conversation.snapshot();
  assert.equal(snapshot.pending.status, "processing");
  assert.equal(snapshot.observation, "unavailable");
  assert.equal(snapshot.pending.partialText, "Partial");
  assert.equal(calls.filter((call) => call.stream).length, 1);
});

test("an open stream with no text stays processing and has no elapsed-time cutoff", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const events = (async function* () {
    yield terminal("created");
    await gate;
    yield itemDone("A considered answer");
    yield terminal();
  })();
  const { conversation, calls, store, controllers, settled } = await setup(events);
  await conversation.send({ id: "first", text: "Think carefully" });
  await until(async () => (await store.read()).pendingAgentTurn?.turnId === "turn_1");
  // The model can keep reasoning without emitting text; there is no turn-duration signal.
  assert.equal(calls.find((call) => call.stream).options.signal, undefined);
  const snapshot = await conversation.snapshot();
  assert.equal(snapshot.pending.status, "processing");
  assert.equal(snapshot.pending.partialText, "");
  assert.equal(snapshot.observation, "current");
  assert.equal(controllers[0].signal.aborted, false);
  release();
  await settled();
  assert.equal((await conversation.snapshot()).messages[1].text, "A considered answer");
});

test("observation failure does not mutate the stored generation state", async () => {
  const { conversation, sessions, store, settled, calls } = await setup([terminal("created"), itemDone("Partial")]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  const before = await store.read();
  sessions.turns.retrieve = async () => { throw new Error("Upstream unavailable"); };
  for (let i = 0; i < 3; i++) {
    const snapshot = await conversation.snapshot();
    assert.equal(snapshot.observation, "unavailable");
    assert.equal(snapshot.pending.status, "processing");
  }
  assert.deepEqual(await store.read(), before);
  await conversation.retry("first");
  assert.equal(calls.filter((call) => call.stream).length, 1);
  sessions.turns.retrieve = async () => ({ id: "turn_1", status: "in_progress" });
  sessions.items.list = async function* () { throw new Error("Partial text unavailable"); };
  const running = await conversation.snapshot();
  assert.equal(running.observation, "current", "A successfully observed running turn clears the outage");
  assert.equal(running.pending.partialText, "Partial");
});

test("completed work stays completed while its result is unavailable", async () => {
  const { conversation, sessions, settled, calls } = await setup([terminal()]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  sessions.turns.retrieve = () => assert.fail("A confirmed completion need not be re-established");
  sessions.items.list = async function* () { throw new Error("Result unavailable"); };
  const snapshot = await conversation.snapshot();
  assert.equal(snapshot.pending.status, "completed");
  assert.equal(snapshot.observation, "unavailable");
  await conversation.retry("first");
  assert.equal(calls.filter((call) => call.stream).length, 1);
  sessions.items.list = async function* () { yield answer("Published result"); };
  const complete = await conversation.snapshot();
  assert.equal(complete.pending, null);
  assert.equal(complete.observation, "current");
  assert.equal(complete.messages[1].text, "Published result");
});

test("a turn waiting for external input is not mistaken for normal generation", async () => {
  const { conversation, sessions, settled, calls } = await setup([terminal("created")]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  sessions.turns.retrieve = async () => ({ id: "turn_1", status: "waiting" });
  const snapshot = await conversation.snapshot();
  assert.equal(snapshot.pending.status, "processing");
  assert.equal(snapshot.observation, "unavailable");
  await conversation.retry("first");
  assert.equal(calls.filter((call) => call.stream).length, 1);
});

for (const status of ["failed", "cancelled"]) {
  test(`only an explicit retry restarts a confirmed ${status} turn`, async () => {
    const events = [itemDone("Partial"), terminal(status)];
    const { conversation, settled, calls } = await setup(events);
    await conversation.send({ id: "first", text: "Hello" });
    await settled();
    let snapshot = await conversation.snapshot();
    assert.equal(snapshot.pending.status, "failed");
    assert.equal(snapshot.pending.partialText, "Partial");
    assert.deepEqual(snapshot.messages, []);
    await conversation.send({ id: "first", text: "Hello" });
    assert.equal(calls.filter((call) => call.stream).length, 1);
    events.splice(0, events.length, itemDone("Retried"), terminal("completed", "turn_2"));
    await conversation.retry("first");
    await settled();
    snapshot = await conversation.snapshot();
    assert.equal(snapshot.pending, null);
    assert.equal(snapshot.messages.length, 2);
    assert.equal(snapshot.messages[1].text, "Retried");
    const streams = calls.filter((call) => call.stream);
    assert.equal(streams.length, 2);
    assert.notEqual(streams[0].idempotencyKey, streams[1].idempotencyKey);
  });
}

test("a restart recovers pending work from disk without creating another session", async () => {
  const { conversation, sessions, settled, config, path, calls } = await setup([itemDone("Partial")]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  sessions.turns.list = async function* () { yield { id: "turn_1", status: "completed", subagent_id: null }; };
  sessions.items.list = async function* () { yield answer("Recovered after restart"); };
  const resumed = new Conversation({ ...config, store: new StateStore(path) });
  assert.equal((await resumed.snapshot()).messages[1].text, "Recovered after restart");
  assert.equal(calls.filter((call) => call.create).length, 1);
  assert.equal(calls.filter((call) => call.stream).length, 1);
});

test("does not guess success from the previous completed turn", async () => {
  const { conversation, sessions, settled, store } = await setup([]);
  await store.update((state) => ({ ...state, agentSessionId: "sess_test", agentLastTurnId: "old_turn" }));
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  sessions.turns.list = async function* () { yield { id: "old_turn", status: "completed", subagent_id: null }; };
  assert.equal((await conversation.snapshot()).observation, "unavailable");
});

test("rejects competing inputs and mismatched request IDs", async () => {
  const { conversation, settled, calls } = await setup();
  const results = await Promise.allSettled([
    conversation.send({ id: "first", text: "Hello" }),
    conversation.send({ id: "second", text: "Another" }),
  ]);
  assert.equal(results[1].status, "rejected");
  await settled();
  await assert.rejects(conversation.send({ id: "first", text: "Changed" }), { statusCode: 409 });
  assert.equal(calls.filter((call) => call.stream).length, 1);
});

test("marks pre-input session failures as retryable and rejects legacy state", async () => {
  const { conversation, sessions, store } = await setup();
  sessions.create = async () => { throw new Error("No session"); };
  await conversation.send({ id: "first", text: "Hello" });
  await until(async () => (await store.read()).pendingAgentTurn.status === "failed");
  assert.equal((await conversation.snapshot()).pending.text, "Hello");
  await assert.rejects(store.update(() => ({ conversationId: "legacy", messages: [] })), /invalid shape/);
  await assert.rejects(store.update((state) => ({ ...state, agentSessionId: 123 })), /invalid shape/);
  await assert.rejects(store.update((state) => ({
    ...state, pendingAgentTurn: { ...state.pendingAgentTurn, status: "checking" },
  })), /invalid shape/);
});

test("completion without published text stays checkable instead of enabling duplicate work", async () => {
  const { conversation, sessions, settled, calls } = await setup([terminal()]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  sessions.turns.retrieve = async () => ({ id: "turn_1", status: "completed" });
  const snapshot = await conversation.snapshot();
  assert.equal(snapshot.pending.status, "completed");
  assert.equal(snapshot.observation, "unavailable");
  await conversation.retry("first");
  assert.equal(calls.filter((call) => call.stream).length, 1);
  sessions.items.list = async function* () { yield answer("Published later"); };
  assert.equal((await conversation.snapshot()).messages[1].text, "Published later");
});

test("official SDK server-error streams recover from completed turns with no second POST", async () => {
  const calls = [];
  const errors = [];
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-sdk-"));
  const client = new OpenAI({
    apiKey: "test-only", maxRetries: 0,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method;
      assert.equal(new Headers(init.headers).get("OpenAI-Beta"), "agents=v1");
      calls.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
      if (path.endsWith("/events") && method === "GET") {
        return new Response('event: error\ndata: {"error":{"type":"server_error","code":"internal_error","message":"An internal error occurred."}}\n\n', {
          headers: { "content-type": "text/event-stream", "x-request-id": "req_test" },
        });
      }
      if (path.endsWith("/events")) return new Response(null, { status: 204 });
      if (path.endsWith("/turns")) return Response.json({ data: [{ id: "turn_1", status: "completed", subagent_id: null }], has_more: false });
      if (path.endsWith("/items")) return Response.json({ data: [answer("Recovered")], has_more: false });
      return Response.json({ id: "sess_sdk", status: "idle" });
    },
  });
  const store = new StateStore(join(directory, "state.json"));
  const conversation = new Conversation({ client, model: "test-model", store, logger: { error: (error) => errors.push(error) } });
  await conversation.send({ id: "first", text: "Hello" });
  await until(() => errors.length > 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await conversation.snapshot()).messages[1].text, "Recovered");
  assert.equal(calls.filter((call) => call.path.endsWith("/events") && call.method === "POST").length, 1);
  const subscribe = calls.findIndex((call) => call.path.endsWith("/events") && call.method === "GET");
  const submit = calls.findIndex((call) => call.path.endsWith("/events") && call.method === "POST");
  assert.ok(subscribe < submit);
  assert.equal(errors[0].code, "internal_error");
  assert.equal(errors[0].requestId, "req_test");
  assert.equal(errors[0].headers, undefined);
});
