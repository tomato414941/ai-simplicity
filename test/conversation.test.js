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
  let settledStreams = 0;
  async function settled() {
    const expected = ++settledStreams;
    await until(() => controllers.length >= expected && controllers.every((controller) => controller.signal.aborted));
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

for (const status of ["failed"]) {
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

function gate(t) {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  return { wait, release };
}

test("stop keeps partial text, waits for confirmation, and leaves later input unchanged", async (t) => {
  const end = gate(t);
  let turn = 0;
  const events = { async *[Symbol.asyncIterator]() {
    if (++turn === 1) {
      yield terminal("created");
      yield itemDone("Partial");
      await end.wait;
      yield terminal("cancelled");
    } else { yield itemDone("Next reply"); yield terminal("completed", "turn_2"); }
  } };
  const { conversation, sessions, store, calls, settled, config, path } = await setup(events);
  sessions.events = { create: async (sessionId, request, options) => {
    calls.push({ cancel: sessionId, request, options });
    assert.equal((await store.read()).pendingAgentTurn.stopRequested, true);
  } };
  sessions.turns.retrieve = async () => ({ id: "turn_1", status: "in_progress" });
  await conversation.send({ id: "first", text: "Original request" });
  await until(async () => (await store.read()).pendingAgentTurn.partialText === "Partial");
  assert.equal((await conversation.stop("first")).pending.stopRequested, true);
  const stopping = await conversation.snapshot();
  assert.equal(stopping.pending.status, "processing");
  assert.equal(stopping.pending.partialText, "Partial");
  assert.deepEqual(stopping.messages, []);
  await conversation.stop("first");
  await conversation.snapshot();
  assert.equal(calls.filter((call) => call.cancel).length, 1);
  assert.deepEqual(calls.find((call) => call.cancel).request, { events: [{ type: "agent.session.input.cancel" }] });
  assert.equal(calls.find((call) => call.cancel).options.maxRetries, 0);
  await assert.rejects(conversation.send({ id: "second", text: "Too soon" }), { statusCode: 409 });
  end.release();
  await settled();
  const stopped = await conversation.snapshot();
  assert.equal(stopped.pending, null);
  assert.equal(stopped.messages[1].text, "Partial");
  assert.equal(stopped.messages[1].interruption, "user");
  await assert.rejects(conversation.retry("first"), { statusCode: 409 });
  assert.equal(calls.filter((call) => call.stream).length, 1, "Stopping itself must not generate an acknowledgement");
  const resumed = new Conversation({ ...config, store: new StateStore(path) });
  await resumed.send({ id: "second", text: "A different question" });
  await until(async () => (await resumed.snapshot()).messages.length === 4);
  const input = calls.filter((call) => call.stream)[1].input;
  assert.equal(input, "A different question", "Stopping must not add text or instructions to the next input");
  assert.equal((await resumed.snapshot()).messages[2].text, "A different question");
  await resumed.send({ id: "third", text: "Another question" });
  await until(async () => (await resumed.snapshot()).messages.length === 6);
  assert.equal(calls.filter((call) => call.stream)[2].input, "Another question");
});

test("stop before session creation completes never submits input or invents output", async (t) => {
  const creation = gate(t);
  const { conversation, sessions, calls, store } = await setup();
  sessions.create = async () => { await creation.wait; return { id: "sess_test" }; };
  await conversation.send({ id: "first", text: "Do not start this" });
  await conversation.stop("first");
  assert.equal((await conversation.snapshot()).pending.stopRequested, true);
  creation.release();
  await until(async () => (await store.read()).messages.length === 2);
  const state = await conversation.snapshot();
  assert.equal(state.pending, null);
  assert.equal(state.messages[1].text, "");
  assert.equal(state.messages[1].interruption, "user");
  assert.equal(calls.filter((call) => call.stream).length, 0);
});

test("an early stop waits for the new turn identity instead of cancelling the previous turn", async (t) => {
  const created = gate(t);
  const { conversation, sessions, store, calls, controllers, settled } = await setup((async function* () {
    await created.wait;
    yield terminal("created");
    yield terminal("cancelled");
  })());
  await store.update((state) => ({ ...state, agentSessionId: "sess_test", agentLastTurnId: "previous_turn" }));
  sessions.turns.list = async function* () { yield { id: "previous_turn", subagent_id: null, status: "completed" }; };
  sessions.events = { create: async () => { calls.push({ cancel: true }); } };
  await conversation.send({ id: "first", text: "Hello" });
  await until(() => controllers.length === 1);
  await conversation.stop("first");
  await conversation.snapshot();
  assert.equal(calls.filter((call) => call.cancel).length, 0);
  created.release();
  await settled();
  assert.equal(calls.filter((call) => call.cancel).length, 1);
  assert.equal((await conversation.snapshot()).messages[1].interruption, "user");
});

test("a persisted stop survives an upstream error and restart without resubmitting the message", async () => {
  const { conversation, sessions, store, calls, config, path, settled } = await setup([terminal("created"), itemDone("Partial")]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  let status = "in_progress";
  sessions.turns.retrieve = async () => ({ id: "turn_1", status });
  sessions.events = { create: async () => { throw new Error("Private cancellation error"); } };
  await conversation.stop("first");
  const unknown = await conversation.snapshot();
  assert.equal(unknown.observation, "unavailable");
  assert.equal(unknown.pending.stopRequested, true);
  assert.equal(unknown.pending.status, "processing");
  assert.equal((await store.read()).messages.length, 0);
  const resumed = new Conversation({ ...config, store: new StateStore(path) });
  sessions.events.create = async () => { calls.push({ cancel: true }); status = "cancelled"; };
  await resumed.snapshot();
  sessions.items.list = async function* () { throw new Error("Items unavailable"); };
  const stopped = await resumed.snapshot();
  assert.equal(stopped.pending, null);
  assert.equal(stopped.messages[1].text, "Partial");
  assert.equal(stopped.messages[1].interruption, "user");
  assert.equal(calls.filter((call) => call.cancel).length, 1);
  assert.equal(calls.filter((call) => call.stream).length, 1);
});

test("provider cancellation is not a failed request or an invented user stop", async () => {
  const { conversation, settled, calls } = await setup([itemDone("Partial"), terminal("cancelled")]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  const state = await conversation.snapshot();
  assert.equal(state.pending, null);
  assert.equal(state.messages[1].interruption, "provider");
  await assert.rejects(conversation.retry("first"), { statusCode: 409 });
  await conversation.send({ id: "second", text: "Next" });
  await settled();
  assert.equal(calls.filter((call) => call.stream)[1].input, "Next");
});

test("completion winning a stop race is kept as completion, and late stop clicks cannot touch the next turn", async () => {
  const { conversation, sessions, settled, calls } = await setup([terminal("created"), itemDone("Partial")]);
  await conversation.send({ id: "first", text: "Hello" });
  await settled();
  sessions.events = { create: async () => { calls.push({ cancel: true }); } };
  sessions.turns.retrieve = async () => ({ id: "turn_1", status: "completed" });
  sessions.items.list = async function* () { yield answer("Complete"); };
  await conversation.stop("first");
  const state = await conversation.snapshot();
  assert.equal(state.pending, null);
  assert.equal(state.messages[1].text, "Complete");
  assert.equal(state.messages[1].interruption, undefined);
  const cancels = calls.filter((call) => call.cancel).length;
  await conversation.send({ id: "second", text: "Next" });
  await settled();
  await conversation.stop("first");
  assert.equal(calls.filter((call) => call.cancel).length, cancels);
  await assert.rejects(conversation.stop("unknown"), { statusCode: 409 });
});

test("late events from an interrupted stream never overwrite the next request", async (t) => {
  const late = gate(t);
  let number = 0;
  const events = { async *[Symbol.asyncIterator]() {
    if (++number === 1) {
      yield terminal("created"); yield itemDone("Partial");
      await late.wait;
      yield itemDone("Stale text"); yield terminal();
    } else { yield itemDone("Next answer"); yield terminal("completed", "turn_2"); }
  } };
  const { conversation, sessions, store } = await setup(events);
  sessions.events = { create: async () => {} };
  sessions.turns.retrieve = async () => ({ id: "turn_1", status: "cancelled" });
  await conversation.send({ id: "first", text: "Hello" });
  await until(async () => (await store.read()).pendingAgentTurn.partialText === "Partial");
  await conversation.stop("first");
  await conversation.snapshot();
  await conversation.send({ id: "second", text: "Next" });
  await until(async () => (await store.read()).messages.length === 4);
  late.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await conversation.snapshot()).messages.map((message) => message.text), ["Hello", "Partial", "Next", "Next answer"]);
});

test("a delayed cancellation event preserves text already recovered ahead of the stream", async (t) => {
  const end = gate(t);
  const { conversation, sessions, store, settled } = await setup((async function* () {
    yield terminal("created"); yield itemDone("Partial");
    await end.wait;
    yield terminal("cancelled");
  })());
  sessions.events = { create: async () => {} };
  sessions.turns.retrieve = async () => ({ id: "turn_1", status: "in_progress" });
  sessions.items.list = async function* () { yield answer("Partial text recovered from saved work"); };
  await conversation.send({ id: "first", text: "Hello" });
  await until(async () => (await store.read()).pendingAgentTurn.partialText === "Partial");
  await conversation.stop("first");
  assert.equal((await conversation.snapshot()).pending.partialText, "Partial text recovered from saved work");
  end.release();
  await settled();
  assert.equal((await conversation.snapshot()).messages[1].text, "Partial text recovered from saved work");
});
