import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { app, session, turn, item, page, messageEvent, turnEvent, authFetch as fetch } from "./helpers.js";

// The clients use only the public HTTP contract, not the Web application's state helpers.
// Only OpenAI's transport is simulated; requests pass through the real application server.
for (const outcome of ["cancelled", "completed"]) {
  test(`two independent clients recover accepted input and observe ${outcome} after a stop request`, { timeout: 5_000 }, async (t) => {
    const current = session(), items = [], turns = [], subscribers = new Set(), accepted = new Map();
    let eventId = 0, cancelRequests = 0;
    const emit = (event) => {
      const value = { session_id: current.id, ...event, event_id: `evt_${++eventId}` };
      const bytes = new TextEncoder().encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      for (const subscriber of subscribers) subscriber.enqueue(bytes);
      return value;
    };
    const { base, requests } = await app(t, async ({ method, path, body, headers, signal }) => {
      if (method === "POST") {
        const event = body.events[0];
        if (event.type === "agent.session.input.cancel") {
          cancelRequests++;
          return new Response(null, { status: 204 }); // Acceptance is not the turn's outcome.
        }
        assert.equal(event.type, "agent.session.input.message");
        const key = headers.get("idempotency-key");
        assert.ok(key);
        if (accepted.has(key)) {
          assert.deepEqual(body, accepted.get(key));
          return new Response(null, { status: 204 });
        }
        accepted.set(key, body);
        let active = turns.findLast((value) => !["completed", "failed", "cancelled"].includes(value.status));
        if (!active) {
          active = turn({ id: `turn_${turns.length + 1}` });
          turns.push(active);
          emit(turnEvent(active));
        }
        current.status = "in_progress";
        for (const input of event.input) {
          const value = {
            ...input, id: `msg_${items.length + 1}`, type: "message", phase: null,
            status: "completed", turn_id: active.id,
          };
          items.push(value);
          emit({ type: "agent.session.turn.item.done", item: value, output_index: items.length - 1, turn_id: active.id });
        }
        if (key === "first-input") {
          return Response.json({ error: { type: "server_error", code: "internal_error", message: "Acknowledgment lost after acceptance" } }, { status: 503 });
        }
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/events")) {
        let output;
        return new Response(new ReadableStream({
          start(controller) {
            output = controller;
            subscribers.add(output);
            signal.addEventListener("abort", () => {
              if (subscribers.delete(output)) output.error(new Error("Subscription closed"));
            }, { once: true });
          },
          cancel() { subscribers.delete(output); },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (path.endsWith("/items")) return Response.json(page(items));
      if (path.endsWith("/turns")) return Response.json(page(turns));
      if (path.includes("/turns/")) return Response.json(turns.find((value) => path.endsWith(`/${value.id}`)));
      return Response.json(current);
    });
    const makeClient = () => new OpenAI({ apiKey: "local-test", baseURL: base + "/v1", maxRetries: 0 });
    const a = makeClient().beta.agents.sessions, b = makeClient().beta.agents.sessions;
    const streamA = await a.events.stream(current.id), streamB = await b.events.stream(current.id);
    t.after(() => { streamA.controller.abort(); streamB.controller.abort(); });
    const eventsA = streamA[Symbol.asyncIterator](), eventsB = streamB[Symbol.asyncIterator]();

    await assert.rejects(a.events.create(current.id, { events: [messageEvent("same text")], "Idempotency-Key": "first-input" }), { status: 503 });
    await b.events.create(current.id, { events: [messageEvent("same text")], "Idempotency-Key": "first-input" });
    assert.equal(turns.length, 1);
    assert.equal(items.length, 1);
    for (let i = 0; i < 2; i++) assert.deepEqual((await eventsA.next()).value, (await eventsB.next()).value);

    // A separate input with the same text is not a duplicate, and steers the active turn.
    await b.events.create(current.id, { events: [messageEvent("same text")], "Idempotency-Key": "second-input" });
    assert.equal(turns.length, 1);
    assert.equal(items.length, 2);
    assert.notEqual(items[0].id, items[1].id);
    assert.deepEqual((await eventsA.next()).value, (await eventsB.next()).value);
    assert.deepEqual((await a.items.list(current.id)).data, (await b.items.list(current.id)).data);

    streamA.controller.abort();
    await eventsA.return();
    assert.equal((await b.turns.retrieve(turns[0].id, { session_id: current.id })).status, "in_progress");
    assert.equal(cancelRequests, 0, "Closing a client only closes its subscription");

    await b.events.create(current.id, { events: [{ type: "agent.session.input.cancel" }] });
    assert.equal(cancelRequests, 1);
    assert.equal((await a.turns.retrieve(turns[0].id, { session_id: current.id })).status, "in_progress");
    turns[0].status = outcome;
    turns[0].completed_at = 2;
    current.status = "idle";
    const answer = item("answer", { status: outcome === "completed" ? "completed" : "incomplete" });
    items.push(answer);
    emit({ type: "agent.session.turn.item.done", item: answer, output_index: 2, turn_id: turns[0].id });
    emit(turnEvent(turns[0]));
    assert.deepEqual((await eventsB.next()).value.item, answer);
    assert.equal((await eventsB.next()).value.turn.status, outcome);

    // Recovery opens a fresh subscription before reading saved work. No mutation is replayed.
    const reconnected = await a.events.stream(current.id);
    t.after(() => reconnected.controller.abort());
    const reconnectedEvents = reconnected[Symbol.asyncIterator]();
    const [sessionA, sessionB, itemsA, itemsB, turnsA, turnsB] = await Promise.all([
      a.retrieve(current.id), b.retrieve(current.id), a.items.list(current.id), b.items.list(current.id),
      a.turns.list(current.id), b.turns.list(current.id),
    ]);
    assert.deepEqual(sessionA, sessionB);
    assert.deepEqual(itemsA.data, itemsB.data);
    assert.deepEqual(turnsA.data, turnsB.data);
    assert.equal(turnsA.data[0].status, outcome);
    const idle = emit({ type: "agent.session.idle" });
    assert.deepEqual((await reconnectedEvents.next()).value, idle, "A new stream does not replay old events");
    assert.equal(requests.filter((request) => request.method === "POST").length, 4);
    reconnected.controller.abort();
    streamB.controller.abort();
    await reconnectedEvents.return();
    await eventsB.return();
  });
}
