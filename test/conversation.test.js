import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import OpenAI from "openai";
import { Conversation } from "../src/conversation.js";
import { StateStore } from "../src/state-store.js";

const terminal = (type = "completed", id = "turn_1") => ({
  type: `agent.session.turn.${type}`,
  turn_id: id,
  turn: { id, subagent_id: null, status: type },
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
  const sessions = {
    create: async (request) => { calls.push({ create: request }); return { id: "sess_test" }; },
    stream: (id, request) => {
      calls.push({ stream: id, ...request });
      const controller = new AbortController();
      controllers.push(controller);
      return Object.assign((async function* () { yield* events; })(), { controller });
    },
    turns: { list: async function* () {} },
    items: { list: async function* () {} },
  };
  const conversation = new Conversation({ client: { beta: { agents: { sessions } } }, model: "test-model", store });
  return { conversation, sessions, store, calls, controllers, path };
}

test("preserves legacy history and imports it as quoted context on the first turn", async () => {
  const { conversation, store, calls, path } = await setup();
  const messages = [{ role: "user", text: "My name is Aki", createdAt: "2026-01-01" },
    { role: "assistant", text: "Hello Aki", createdAt: "2026-01-01" }];
  await store.update(() => ({ conversationId: "conv_legacy", messages }));
  await conversation.send("Remember me?");
  assert.match(calls[1].input, /"role":"assistant","text":"Hello Aki"/);
  assert.match(calls[1].input, /Current user message:\nRemember me\?/);
  assert.doesNotMatch(calls[0].create.agent.instructions, /My name is Aki/);
  const reloaded = await new StateStore(path).read();
  assert.equal(reloaded.conversationId, "conv_legacy");
  assert.equal(reloaded.agentSessionId, "sess_test");
  assert.equal(reloaded.pendingAgentTurn, null);
  assert.deepEqual(reloaded.messages.slice(0, 2), messages);
});

test("combines text parts, accepts done-only text, and excludes commentary and tool output", async () => {
  const { conversation, controllers } = await setup([
    itemDone("Internal progress", "progress", "commentary"),
    { type: "agent.session.turn.output_text.delta", item_id: "progress", content_index: 0, delta: "Hidden" },
    { type: "agent.session.turn.item.added", item: answer("Old", "msg_1") },
    { type: "agent.session.turn.output_text.delta", item_id: "msg_1", content_index: 0, delta: " delta" },
    { type: "agent.session.turn.output_text.done", item_id: "msg_1", content_index: 0, text: "First" },
    { type: "agent.session.turn.output_text.done", item_id: "msg_1", content_index: 1, text: " part" },
    { type: "agent.session.turn.item.done", item: { type: "command_execution", output: "Private tool log" } },
    itemDone("Second", "msg_2"), terminal(),
  ]);
  const deltas = [];
  const reply = await conversation.send("Hello", { onDelta: (text) => deltas.push(text) });
  assert.equal(reply.text, "First part\n\nSecond");
  assert.deepEqual(deltas, [" delta"]);
  assert.equal(controllers[0].signal.aborted, true);
});

for (const ending of ["failed", "cancelled", "idle", "environment.failed", "requires_action", "eof"]) {
  test(`does not save partial text as success on ${ending}`, async () => {
    const events = [itemDone("Partial")];
    if (["failed", "cancelled"].includes(ending)) events.push(terminal(ending));
    else if (ending !== "eof") events.push({ type: `agent.session.${ending}` });
    const { conversation, store, controllers } = await setup(events);
    await assert.rejects(conversation.send("Hello"));
    assert.deepEqual((await store.read()).messages, []);
    assert.equal(controllers[0].signal.aborted, true);
  });
}

test("reuses a persisted session after restarting the conversation service", async () => {
  const { conversation, sessions, store, calls, path } = await setup();
  await conversation.send("First");
  const resumed = new Conversation({ client: { beta: { agents: { sessions } } }, model: "test-model", store: new StateStore(path) });
  await resumed.send("Second");
  assert.equal(calls.filter((call) => call.create).length, 1);
  assert.equal(calls.at(-1).input, "Second");
  assert.equal((await store.read()).agentSessionId, "sess_test");
});

test("rejects an empty completed answer without leaving the conversation stuck", async () => {
  const { conversation, store } = await setup([terminal()]);
  await assert.rejects(conversation.send("Hello"), /no final text/);
  assert.equal((await store.read()).pendingAgentTurn, null);
  assert.deepEqual(await conversation.messages(), []);
});

test("validates persisted session and pending-input fields", async () => {
  const { store } = await setup();
  await assert.rejects(store.update((state) => ({ ...state, agentSessionId: 123 })), /invalid shape/);
  await assert.rejects(store.update((state) => ({ ...state, agentSessionId: "sess_test", pendingAgentTurn: { text: "Hello" } })), /invalid shape/);
});

test("recovers completed work after a disconnect without running the input again", async () => {
  const { conversation, sessions, store, calls } = await setup([itemDone("Partial")]);
  await assert.rejects(conversation.send("Check the web"));
  sessions.turns.list = async function* () { yield { id: "turn_1", status: "completed", subagent_id: null }; };
  sessions.items.list = async function* () {
    yield answer("Progress", "progress", "commentary");
    yield { ...answer("Old reply"), turn_id: "turn_old" };
    yield answer("Verified result");
  };
  const reply = await conversation.send("Check the web");
  assert.equal(reply.text, "Verified result");
  assert.equal(calls.filter((call) => call.stream).length, 1);
  assert.equal((await store.read()).messages.length, 2);
});

test("does not submit another input while disconnected work is still running", async () => {
  const { conversation, sessions, calls } = await setup([]);
  await assert.rejects(conversation.send("Check the web"));
  sessions.turns.list = async function* () { yield { id: "turn_1", status: "in_progress", subagent_id: null }; };
  await assert.rejects(conversation.send("Check the web"), /still running/);
  await assert.rejects(conversation.send("Different request"), /still running/);
  assert.equal(calls.filter((call) => call.stream).length, 1);
});

test("retries an unsubmitted input with the same idempotency key", async () => {
  const { conversation, sessions, calls } = await setup();
  const stream = sessions.stream;
  let originalKey;
  sessions.stream = (id, request) => {
    originalKey = request.idempotencyKey;
    return Object.assign((async function* () { throw new Error("Connection failed"); })(), { controller: new AbortController() });
  };
  await assert.rejects(conversation.send("Hello"));
  sessions.stream = stream;
  await conversation.send("Hello");
  assert.equal(calls.at(-1).idempotencyKey, originalKey);
});

test("serializes concurrent inputs so messages do not steer an active turn", async () => {
  const { conversation, sessions } = await setup();
  const stream = sessions.stream;
  let running = false;
  sessions.stream = (id, request) => {
    assert.equal(running, false);
    running = true;
    const events = stream(id, request);
    return Object.assign((async function* () {
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield* events;
      running = false;
    })(), { controller: events.controller });
  };
  await Promise.all([conversation.send("First"), conversation.send("Second")]);
  assert.equal((await conversation.messages()).length, 4);
});

test("uses official SDK beta headers and subscribes before sending input", async () => {
  const calls = [];
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-sdk-"));
  const client = new OpenAI({
    apiKey: "test-only", maxRetries: 0,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method;
      assert.equal(new Headers(init.headers).get("OpenAI-Beta"), "agents=v1");
      calls.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
      if (path.endsWith("/events") && method === "GET") {
        const events = [{ type: "agent.session.idle" }, terminal("created"), itemDone("SDK reply"), terminal(), { type: "agent.session.idle" }];
        return new Response(events.map((event, index) => `data: ${JSON.stringify({ event_id: `ev_${index}`, session_id: "sess_sdk", ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      if (path.endsWith("/events")) return new Response(null, { status: 204 });
      return Response.json({ id: "sess_sdk", status: "idle" });
    },
  });
  const conversation = new Conversation({ client, model: "test-model", store: new StateStore(join(directory, "state.json")) });
  assert.equal((await conversation.send("Hello")).text, "SDK reply");
  assert.deepEqual(calls.map(({ path, method }) => [method, path]), [
    ["POST", "/v1/agents/sessions"], ["GET", "/v1/agents/sessions/sess_sdk"],
    ["GET", "/v1/agents/sessions/sess_sdk/events"], ["POST", "/v1/agents/sessions/sess_sdk/events"],
  ]);
  assert.equal(calls.at(-1).body.events[0].input[0].content[0].text, "Hello");
});
