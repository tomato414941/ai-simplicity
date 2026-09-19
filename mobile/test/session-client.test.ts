import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SessionClient } from "../src/session-client.ts";
import { session, turn, item, userItem, page, turnEvent } from "../../test/helpers.js";

const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };

async function boot(t: TestContext, options: Record<string, any> = {}) {
  const requests: { path: string; method: string; body?: any; headers: Headers }[] = [];
  const saved: Map<string, string> = options.saved ?? new Map();
  const remote = { session: session(), items: [] as any[], turns: [] as any[], fail: false, loseSend: false, failStorage: false, ...options.remote };
  const streams: { controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean }[] = [];
  const accepted = new Set<string>();
  const emit = (event: any) => {
    const data = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    streams.filter((stream) => !stream.closed).forEach((stream) => stream.controller.enqueue(data));
  };
  let key = 0;
  const client = new SessionClient({
    origin: "https://api.example.test", userId: options.userId ?? "user-a", token: "user-a-token", defaults: { agent: { model: "gpt-6-astra" }, environment: { type: "openai_hosted" } },
    uuid: () => `key-${++key}`,
    storage: { getItem: async (key) => saved.get(key) ?? null, setItem: async (key, value) => {
      if (remote.failStorage) throw new Error("Disk unavailable"); saved.set(key, value);
    } },
    fetch: async (path, init = {}) => {
      const url = new URL(String(path));
      const request = { path: url.pathname + url.search, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init.headers) };
      requests.push(request);
      if (remote.fail) throw new Error("Offline");
      const custom = await options.fetch?.(request, { remote, emit });
      if (custom) return custom;
      if (request.method === "POST") {
        if (url.pathname.endsWith("/sessions")) { remote.session = session(); return Response.json(remote.session); }
        if (request.body.events[0].type === "agent.session.input.message") {
          const idempotencyKey = request.headers.get("idempotency-key")!;
          if (!accepted.has(idempotencyKey)) {
            accepted.add(idempotencyKey);
            const current = turn({ id: `turn-${remote.turns.length + 1}` });
            remote.turns.push(current); remote.session.status = "in_progress";
            const input = userItem(request.body.events[0].input[0].content[0].text, { id: `input-${current.id}`, turn_id: current.id });
            remote.items.push(input); emit(turnEvent(current)); emit({ type: "agent.session.turn.item.done", item: input });
          }
          if (remote.loseSend) { remote.loseSend = false; throw new Error("Lost acknowledgment"); }
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/events")) {
        const stream = { closed: false } as typeof streams[number];
        const body = new ReadableStream<Uint8Array>({ start(controller) { stream.controller = controller; }, cancel() { stream.closed = true; } });
        streams.push(stream);
        init.signal?.addEventListener("abort", () => { if (!stream.closed) { stream.closed = true; stream.controller.error(new Error("Aborted")); } });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/items") || url.pathname.endsWith("/turns")) {
        const all = url.pathname.endsWith("/items") ? remote.items : remote.turns;
        const after = url.searchParams.get("after");
        const start = after ? all.findIndex((value: any) => value.id === after) + 1 : 0;
        return Response.json(page(all.slice(start, start + 100), start + 100 < all.length));
      }
      return Response.json(url.pathname.endsWith("/sessions") ? page(remote.session ? [remote.session] : []) : remote.session);
    },
  });
  t.after(() => client.dispose());
  await client.start(); await flush();
  return { client, requests, remote, streams, saved, emit,
    view: () => client.getSnapshot(),
    send: async (text: string) => { client.setDraft(text); await client.send(); await flush(); },
    async finish(status = "completed", text = "返答です") {
      const latest = remote.turns.at(-1);
      latest.status = status; remote.session.status = "idle";
      if (text) {
        const answer = item(text, { id: `answer-${latest.id}`, turn_id: latest.id, status: status === "completed" ? "completed" : "incomplete" });
        remote.items.push(answer); emit({ type: "agent.session.turn.item.done", item: answer });
      }
      emit(turnEvent(latest)); await flush();
    },
    async disconnect() { streams.filter((stream) => !stream.closed).forEach((stream) => { stream.closed = true; stream.controller.error(new Error("Offline")); }); await flush(); },
  };
}

test("new anonymous visitors do not allocate an agent; first input uses native endpoints", async (t) => {
  const ui = await boot(t, { remote: { session: null } });
  assert.equal(ui.requests.length, 1);
  await ui.send("こんにちは");
  assert.deepEqual(ui.requests.filter((r) => r.method === "POST").map((r) => r.path), ["/v1/agents/sessions", `/v1/agents/sessions/${ui.remote.session.id}/events`]);
  assert.equal(ui.view().generating, true);
  assert.deepEqual(ui.view().messages.map((m) => m.text), ["こんにちは"]);
});

test("SSE starts before the paginated snapshot and a long turn has no polling or timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ui = await boot(t, { remote: { items: Array.from({ length: 205 }, (_, n) => userItem(`text-${n}`, { id: `item-${n}` })), turns: [turn()] } });
  assert.equal(ui.view().messages.length, 205);
  assert.ok(ui.requests.findIndex((r) => r.path.endsWith("/events")) < ui.requests.findIndex((r) => r.path.includes("/items?")));
  assert.equal(ui.requests.filter((r) => r.path.includes("/items?")).length, 3);
  const count = ui.requests.length;
  t.mock.timers.tick(10 * 60_000); await flush();
  assert.equal(ui.requests.length, count);
  assert.equal(ui.view().generating, true);
  assert.equal(ui.streams[0].closed, false);
});

test("deltas update the same item without requests; terminal state restores send", async (t) => {
  const ui = await boot(t);
  await ui.send("質問");
  ui.emit({ type: "agent.session.turn.item.added", item: item("", { id: "answer-turn-1", turn_id: "turn-1" }) }); await flush();
  const count = ui.requests.length;
  for (const delta of ["返", "答", "です"]) ui.emit({ type: "agent.session.turn.output_text.delta", item_id: "answer-turn-1", content_index: 0, delta });
  await flush();
  assert.deepEqual(ui.view().messages.map((m) => m.text), ["質問", "返答です"]);
  assert.equal(ui.requests.length, count);
  await ui.finish();
  assert.equal(ui.view().generating, false);
  ui.client.setDraft("次の質問"); assert.equal(ui.view().canSend, true);
});

test("lost acknowledgment is read-recovered, not resent; explicit retry keeps the native key", async (t) => {
  const ui = await boot(t, { remote: { loseSend: true } });
  await ui.send("一度だけ");
  await ui.client.retry(); await flush();
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
  assert.equal(ui.view().action, "もう一度送信");
  await ui.client.retry(); await flush();
  const posts = ui.requests.filter((r) => r.method === "POST");
  assert.equal(posts[0].headers.get("idempotency-key"), posts[1].headers.get("idempotency-key"));
  assert.equal(ui.remote.turns.length, 1);
  assert.equal(JSON.parse(ui.saved.get("ai-simplicity.user-a.input")!).pending, null);
});

test("uncertain submissions survive restart, and drafts are separated by user", async (t) => {
  const first = await boot(t, { remote: { loseSend: true } });
  await first.send("保存した入力"); first.client.dispose();
  const restarted = await boot(t, { saved: first.saved, remote: first.remote });
  assert.equal(restarted.view().action, "もう一度送信");
  assert.equal(restarted.requests.filter((r) => r.method === "POST").length, 0);
  const other = await boot(t, { saved: first.saved, userId: "user-b", remote: { session: null } });
  assert.equal(other.view().hasConversation, false);
  assert.equal(other.view().draft, "");
});

test("stop acknowledgment is not cancellation; the same composer stays in stop mode", async (t) => {
  const ui = await boot(t);
  await ui.send("長い質問"); await ui.client.stop();
  assert.equal(ui.view().stopping, true);
  assert.equal(ui.view().generating, true);
  assert.equal(ui.view().canStop, false);
  assert.deepEqual(ui.requests.at(-1)?.body, { events: [{ type: "agent.session.input.cancel" }] });
  await ui.finish("cancelled", "途中まで");
  assert.equal(ui.view().stopping, false);
  assert.equal(ui.view().generating, false);
  assert.equal(ui.view().messages.at(-1)?.ending, "停止しました");
});

test("backgrounding closes only the subscription; foreground recovers completion", async (t) => {
  const ui = await boot(t);
  await ui.send("質問");
  const count = ui.requests.length;
  ui.client.pause(); await flush();
  assert.equal(ui.requests.length, count);
  assert.equal(ui.streams.every((s) => s.closed), true);
  await ui.finish("completed", "留守中の返答");
  ui.client.resume(); await flush();
  assert.equal(ui.view().generating, false);
  assert.equal(ui.view().messages.at(-1)?.text, "留守中の返答");
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
});

test("storage failure prevents any write to the provider and preserves draft", async (t) => {
  const ui = await boot(t, { remote: { failStorage: true } });
  await ui.send("消さない入力");
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(ui.view().draft, "消さない入力");
  assert.match(ui.view().status, /保存できない/);
});

test("a rejected input returns to the composer", async (t) => {
  const ui = await boot(t, { fetch: async (request: any) => request.method === "POST" ? Response.json({}, { status: 429 }) : null });
  await ui.send("もう一度送れる入力");
  assert.equal(ui.view().draft, "もう一度送れる入力");
  assert.equal(ui.view().canSend, true);
  assert.match(ui.view().status, /送れませんでした/);
});

test("recovery ends 60 seconds after a communication error, without declaring generation failed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const ui = await boot(t, { remote: { turns: [turn()] } });
  ui.remote.fail = true;
  await ui.disconnect();
  for (let n = 0; n < 60; n++) { t.mock.timers.tick(1_000); await flush(); }
  assert.equal(ui.view().action, "もう一度確認");
  assert.equal(ui.view().generating, true);
  const count = ui.requests.length;
  t.mock.timers.tick(10 * 60_000); await flush();
  assert.equal(ui.requests.length, count);
  assert.equal(ui.requests.some((r) => r.method === "POST"), false);
});

test("uncertain creation never replays POST automatically", async (t) => {
  const ui = await boot(t, { remote: { session: null }, fetch: async (request: any, { remote }: any) => {
    if (request.method === "POST") { remote.session = session(); throw new Error("Lost create response"); }
  } });
  await ui.send("作成後に切断"); await flush();
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
  assert.equal(ui.view().draft, "作成後に切断");
});

test("confirmed failure offers a deliberate new attempt with a new key", async (t) => {
  const ui = await boot(t);
  await ui.send("失敗した質問"); await ui.finish("failed", "");
  assert.equal(ui.view().action, "再試行");
  assert.equal(ui.view().messages.at(-1)?.ending, "返答を作れませんでした");
  await ui.client.retry(); await flush();
  const posts = ui.requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].headers.get("idempotency-key"), posts[1].headers.get("idempotency-key"));
});

test("failed session and required action do not masquerade as healthy reasoning", async (t) => {
  for (const status of ["failed", "requires_action"]) {
    const ui = await boot(t, { remote: { session: session({ status }), turns: [turn()] } });
    assert.notEqual(ui.view().status, "返答を待っています");
    assert.equal(ui.view().action, "もう一度確認");
  }
});

test("refreshing the token reopens only reads with the new authorization", async (t) => {
  const ui = await boot(t);
  await ui.send("生成中");
  const count = ui.requests.length;
  ui.client.setToken("refreshed-token"); await flush();
  assert.ok(ui.requests.length > count);
  assert.ok(ui.requests.slice(count).every((r) => r.method === "GET" && r.headers.get("authorization") === "Bearer refreshed-token"));
  assert.equal(ui.view().generating, true);
});

test("late cancellation errors cannot override a confirmed terminal turn", async (t) => {
  let rejectCancel: (error: Error) => void;
  const ui = await boot(t, { fetch: async (request: any) => {
    if (request.body?.events?.[0]?.type === "agent.session.input.cancel") return new Promise((_resolve, reject) => { rejectCancel = reject; });
  } });
  await ui.send("質問");
  const stopping = ui.client.stop(); await flush();
  await ui.finish("completed");
  rejectCancel!(new Error("Lost cancel response")); await stopping;
  await ui.client.retry(); await flush();
  assert.equal(ui.view().generating, false);
  assert.doesNotMatch(ui.view().status, /停止/);
});
