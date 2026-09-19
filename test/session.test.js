import assert from "node:assert/strict";
import { test } from "node:test";
import { UserSessions } from "../src/user-sessions.js";
import { SessionState, readEvents, itemText } from "../shared/agent-session.js";
import { session, turn, item, userItem, turnEvent } from "./helpers.js";

test("listing and restarting never allocate an OpenAI environment; creation persists ownership", async () => {
  const saved = new Map();
  const store = { read: async (id) => saved.get(id), write: async (id, sessionId) => saved.set(id, sessionId) };
  let creates = 0;
  const client = { beta: { agents: { sessions: { create: async (body) => {
    creates++;
    assert.equal(body.agent.model, "gpt-6-astra");
    assert.equal(body.input, undefined);
    assert.deepEqual(body.agent.multi_agent, { enabled: false });
    return session();
  }, retrieve: async () => session() } } } };
  const sessions = new UserSessions({ client, model: "gpt-6-astra", store });
  assert.deepEqual((await sessions.list("user", {})).data, []);
  assert.equal(creates, 0);
  await sessions.create("user", sessions.defaults);
  const restarted = new UserSessions({ client, model: "gpt-6-astra", store });
  assert.deepEqual((await restarted.list("user", {})).data, [session()]);
  assert.equal(creates, 1);
  assert.equal(saved.get("user"), "sess_test");
});

test("native items keep IDs, types, phases and content parts; done replaces rather than appends", () => {
  const state = new SessionState();
  state.restore(session(), [userItem()], [turn()]);
  state.apply({ type: "agent.session.turn.item.added", item: item("", { content: [] }) });
  state.apply({ type: "agent.session.turn.output_text.delta", event_id: "evt_1", item_id: "msg_answer", content_index: 1, delta: "long draft" });
  state.apply({ type: "agent.session.turn.output_text.delta", event_id: "evt_1", item_id: "msg_answer", content_index: 1, delta: "long draft" });
  assert.equal(itemText(state.items.get("msg_answer")), "long draft");
  state.apply({ type: "agent.session.turn.output_text.done", item_id: "msg_answer", content_index: 1, text: "short" });
  state.apply({ type: "agent.session.turn.content_part.done", item_id: "msg_answer", content_index: 0, part: { type: "output_text", text: "first ", annotations: [{ type: "url_citation", url: "https://example.com" }] } });
  assert.equal(itemText(state.items.get("msg_answer")), "first short");
  assert.equal(state.items.get("msg_answer").content[0].annotations[0].type, "url_citation");
  const tool = { id: "search_1", type: "web_search_call", turn_id: "turn_1", status: "completed", action: { type: "search", queries: ["query"] } };
  state.apply({ type: "agent.session.turn.item.done", item: tool });
  state.apply({ type: "agent.session.turn.item.done", item: item("comment", { id: "comment", phase: "commentary", status: "completed" }) });
  assert.deepEqual(state.items.get("search_1"), tool);
  assert.equal(state.items.get("comment").phase, "commentary");
});

test("final text can arrive without any delta", () => {
  const state = new SessionState();
  state.apply({ type: "agent.session.turn.item.done", item: item("完成", { status: "completed" }) });
  assert.equal(itemText(state.items.get("msg_answer")), "完成");
});

test("reconnection does not double-append buffered deltas over final saved items", () => {
  const state = new SessionState();
  state.restore(session(), [item("完成", { status: "completed" })], [turn({ status: "completed" })]);
  state.apply({ type: "agent.session.turn.item.added", item: item("") });
  state.apply({ type: "agent.session.turn.output_text.delta", item_id: "msg_answer", content_index: 0, delta: "完成" });
  state.apply(turnEvent({ status: "in_progress" }));
  assert.equal(itemText(state.items.get("msg_answer")), "完成");
  assert.equal(state.latestTurn.status, "completed");
});

test("after a gap, incomplete text waits for an authoritative done instead of guessing delta overlap", () => {
  const state = new SessionState();
  state.restore(session(), [item("保存済みの途中")], [turn()]);
  state.apply({ type: "agent.session.turn.output_text.delta", item_id: "msg_answer", content_index: 0, delta: "途中" });
  assert.equal(itemText(state.items.get("msg_answer")), "保存済みの途中");
  state.apply({ type: "agent.session.turn.output_text.done", item_id: "msg_answer", content_index: 0, text: "保存済みの途中から完成" });
  assert.equal(itemText(state.items.get("msg_answer")), "保存済みの途中から完成");
});

test("published stream items and terminal outcomes survive a lagging history read", () => {
  const state = new SessionState();
  state.restore(session(), [], []);
  state.apply({ type: "agent.session.turn.item.done", item: item("完成", { status: "completed" }) });
  state.apply(turnEvent({ status: "completed" }));
  state.restore(session(), [], [turn()]);
  assert.equal(itemText(state.items.get("msg_answer")), "完成");
  assert.equal(state.latestTurn.status, "completed");
  state.restore(session({ id: "sess_other" }), [], []);
  assert.equal(state.items.size, 0, "Do not leak a prior session's cached history");
});

test("null item IDs allowed by the native schema do not overwrite each other", () => {
  const state = new SessionState();
  state.restore(session(), [userItem("one", { id: null }), userItem("two", { id: null })], [turn()]);
  assert.deepEqual([...state.items.values()].map(itemText), ["one", "two"]);
});

test("idle and subagent completion never imply root turn completion", () => {
  const state = new SessionState();
  state.restore(session({ status: "in_progress" }), [], [turn()]);
  state.apply({ type: "agent.session.idle" });
  state.apply(turnEvent({ id: "subturn", subagent_id: "sub_1", status: "completed" }));
  assert.equal(state.latestTurn.status, "in_progress");
});

for (const ending of ["\n", "\r\n", "\r"]) {
  test(`SSE handles fragmented UTF-8, multiline data and ${JSON.stringify(ending)} framing`, async () => {
    const text = [": comment", "id: evt_1", "event: native", 'data: {"type":"agent.session.turn.output_text.done",', 'data: "text":"日本語"}', "", "data: [DONE]", "", ""].join(ending);
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const events = [];
    for await (const event of readEvents(body)) events.push(event);
    assert.deepEqual(events, [{ type: "agent.session.turn.output_text.done", text: "日本語" }]);
  });
}

test("SSE preserves a native error and does not invent completion on EOF", async () => {
  const error = { type: "error", event_id: "evt_error", session_id: "sess_test", error: { code: "internal_error", message: "Unavailable" } };
  const events = [];
  for await (const event of readEvents(new Response(`data: ${JSON.stringify(error)}\n\ndata: {"unterminated":true}`).body)) events.push(event);
  assert.deepEqual(events, [error]);
});
