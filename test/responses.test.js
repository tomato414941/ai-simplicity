import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { SupabaseResponseStore } from "../src/user-responses.js";
import { app, page, USER_A, USER_B } from "./helpers.js";

const model = "gpt-6-astra";
const creation = { model, input: "こんにちは" };
const output = [{ id: "msg_a", type: "message", role: "assistant", phase: "final_answer", status: "completed",
  content: [{ type: "output_text", text: "こんにちは。", annotations: [] }] }];
const response = (fields = {}) => ({ id: "resp_a", object: "response", model, created_at: 1, status: "completed", output,
  store: true, background: false, previous_response_id: null, metadata: {}, error: null,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, ...fields });
const client = (base, apiKey = "local-test") => new OpenAI({ baseURL: base + "/v1", apiKey, maxRetries: 0 }).responses;
const send = (base, method, path, body, headers = {}) => fetch(base + "/v1/responses" + path, {
  method, headers: { Authorization: "Bearer local-test", "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const frame = (event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
const streamResponse = (text) => new Response(text, { headers: { "content-type": "text/event-stream", "x-request-id": "request_native" } });
const owners = () => new Map([["resp_a", USER_A], ["resp_b", USER_B]]);

test("Responsesの各エンドポイントで認証を要求する", async (t) => {
  const { base, requests } = await app(t, () => assert.fail("Authentication must precede provider access"));
  for (const [method, path, body] of [["POST", "", creation], ["GET", "/resp_a"], ["DELETE", "/resp_a"],
    ["POST", "/resp_a/cancel"], ["GET", "/resp_a/input_items"], ["POST", "/compact", creation], ["POST", "/input_tokens", creation]]) {
    const result = await send(base, method, path, body, { Authorization: "Bearer invalid" });
    assert.equal(result.status, 401);
    assert.equal((await result.json()).error.type, "authentication_error");
  }
  assert.equal(requests.length, 0);
});

test("公式SDKでResponsesを作成し別端末から本人の応答と入力を取得する", async (t) => {
  const input = [{ role: "developer", content: "簡潔に" }, { role: "user", content: [{ type: "input_text", text: "今日のニュース" }] }];
  const body = { model, input, tools: [{ type: "web_search" }], reasoning: { effort: "low" }, text: { verbosity: "low" },
    store: true, metadata: { topic: "news" }, context_management: [{ type: "compaction", compact_threshold: 20000 }] };
  const expected = response({ metadata: body.metadata });
  const { base, requests, responseOwners } = await app(t, ({ path, method }) => {
    if (path.endsWith("/input_items")) return Response.json(page(input));
    return Response.json(expected, { headers: { "x-request-id": "request_native" } });
  });
  const a = client(base), otherDevice = client(base);
  const created = await a.create(body);
  assert.equal(created.output_text, "こんにちは。");
  assert.equal(created.id, "resp_a");
  assert.equal(responseOwners.get(created.id), USER_A);
  assert.deepEqual(requests[0].body, body);
  assert.equal(requests[0].path, "/v1/responses");
  const raw = await otherDevice.retrieve(created.id, { include: ["reasoning.encrypted_content"] }).asResponse();
  assert.deepEqual(await raw.json(), expected);
  assert.equal(raw.headers.get("x-request-id"), "request_native");
  assert.deepEqual((await otherDevice.inputItems.list(created.id, { limit: 2, order: "asc", after: "msg_start" })).data, input);
  assert.equal(requests.at(-1).query.get("limit"), "2");
  assert.equal(requests.at(-1).query.get("order"), "asc");
  assert.equal(requests.at(-1).query.get("after"), "msg_start");
});

test("本人のprevious_response_idで会話を継続しfunctionの結果を渡す", async (t) => {
  const { base, requests } = await app(t, () => Response.json(response({ id: "resp_next", previous_response_id: "resp_a" })), { responseOwners: owners() });
  const body = { model, previous_response_id: "resp_a", input: [{ type: "function_call_output", call_id: "call_a", output: "42" }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {}, additionalProperties: false }, strict: true }],
    tool_choice: { type: "function", name: "lookup" } };
  assert.equal((await client(base).create(body)).previous_response_id, "resp_a");
  assert.deepEqual(requests[0].body, body);
});

test("他人のResponse IDによる参照・削除・停止・会話継続を拒否する", async (t) => {
  const { base, requests } = await app(t, () => assert.fail("Foreign responses must not reach OpenAI"), { responseOwners: owners() });
  const b = client(base, "user-b");
  for (const operation of [() => b.retrieve("resp_a"), () => b.delete("resp_a"), () => b.cancel("resp_a"),
    () => b.inputItems.list("resp_a"), () => b.create({ ...creation, previous_response_id: "resp_a" }),
    () => b.inputTokens.count({ ...creation, previous_response_id: "resp_a" }),
    () => b.compact({ ...creation, previous_response_id: "resp_a" }),
    () => b.create({ ...creation, prompt_cache_options: { comparison_response_id: "resp_a" } })]) {
    await assert.rejects(operation, { status: 404, code: "not_found" });
  }
  assert.equal(requests.length, 0);
});

test("SSEを元のバイト列で中継しResponse ID公開前に所有者を保存する", { timeout: 3000 }, async (t) => {
  const opening = ": keepalive\r\n\r\n" + frame({ type: "response.created", sequence_number: 0, response: response({ status: "in_progress", output: [] }) });
  const delta = frame({ type: "response.output_text.delta", sequence_number: 1, item_id: "msg_a", output_index: 0, content_index: 0, delta: "日本語", obfuscation: "xyz" });
  const ending = frame({ type: "response.completed", sequence_number: 2, response: response() }) + "data: [DONE]\r\n\r\n";
  let output, save, saved = false;
  const { base, responseOwners } = await app(t, () => new Response(new ReadableStream({ start(controller) {
    output = controller;
    // Exercise frames fragmented even within UTF-8 code points.
    for (const byte of new TextEncoder().encode(opening)) controller.enqueue(Uint8Array.of(byte));
  } }), { headers: { "content-type": "text/event-stream" } }), { responseStore: {
    owns: async (userId, id) => responseOwners.get(id) === userId,
    save: (userId, id) => new Promise((resolve) => { save = () => { saved = true; responseOwners.set(id, userId); resolve(); }; }),
  } });
  const pending = send(base, "POST", "", { ...creation, stream: true });
  let exposed = false;
  pending.then(() => { exposed = true; });
  for (let i = 0; !save && i < 100; i++) await delay(2);
  assert.ok(save);
  assert.equal(exposed, false);
  save();
  const result = await pending;
  assert.equal(saved, true);
  assert.equal(responseOwners.get("resp_a"), USER_A);
  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), opening);
  output.enqueue(new TextEncoder().encode(delta));
  assert.equal(new TextDecoder().decode((await reader.read()).value), delta);
  output.enqueue(new TextEncoder().encode(ending)); output.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ending);
  assert.equal((await reader.read()).done, true);
});

test("公式SDKがResponsesのストリーミングイベントを読み取る", async (t) => {
  const events = [{ type: "response.created", sequence_number: 0, response: response({ status: "in_progress", output: [] }) },
    { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_a", output_index: 0, content_index: 0, delta: "こんにちは。" },
    { type: "response.completed", sequence_number: 2, response: response() }];
  const { base } = await app(t, () => streamResponse(events.map(frame).join("")));
  const received = [];
  for await (const event of await client(base).create({ ...creation, stream: true })) received.push(event);
  assert.deepEqual(received, events);
});

test("backgroundの応答を再購読して公式のcancel操作で停止する", async (t) => {
  const current = response({ status: "queued", background: true, output: [] });
  const { base, requests } = await app(t, ({ path, query }) => {
    if (path.endsWith("/cancel")) { current.status = "cancelled"; return Response.json(current); }
    if (query.get("stream") === "true") return streamResponse(frame({ type: "response.in_progress", sequence_number: 5, response: current }));
    return Response.json(current);
  });
  const api = client(base);
  assert.equal((await api.create({ ...creation, background: true })).status, "queued");
  const stream = await api.retrieve("resp_a", { stream: true, starting_after: 4, include_obfuscation: false });
  const received = [];
  for await (const event of stream) received.push(event);
  assert.equal(received[0].sequence_number, 5);
  assert.equal(requests.at(-1).query.get("starting_after"), "4");
  assert.equal(requests.at(-1).query.get("include_obfuscation"), "false");
  assert.equal((await api.cancel("resp_a")).status, "cancelled");
  assert.equal((await api.retrieve("resp_a")).status, "cancelled");
});

test("ストリーム切断では購読だけを閉じbackgroundの生成は明示的な停止に委ねる", async (t) => {
  let signal;
  const { base, requests } = await app(t, (request) => {
    signal = request.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ type: "response.created", response: response({ status: "in_progress", background: true, output: [] }) })));
      signal.addEventListener("abort", () => controller.error(new Error("Viewer left")), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const stream = await client(base).create({ ...creation, stream: true, background: true });
  const events = stream[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.type, "response.created");
  stream.controller.abort();
  await events.return();
  for (let i = 0; !signal.aborted && i < 100; i++) await delay(2);
  assert.equal(signal.aborted, true);
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [["POST", "/v1/responses"]]);
});

test("認証期限が切れたらResponsesの購読を閉じる", { timeout: 3000 }, async (t) => {
  let signal;
  const { base, requests } = await app(t, (request) => {
    signal = request.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ type: "response.in_progress", response: response({ status: "in_progress" }) })));
      signal.addEventListener("abort", () => controller.error(new Error("Credential expired")), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  }, { responseOwners: owners(), authenticate: async () => ({ id: USER_A, expiresAt: Date.now() + 80 }) });
  const stream = await client(base).retrieve("resp_a", { stream: true });
  const events = stream[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.type, "response.in_progress");
  await assert.rejects(events.next());
  assert.equal(signal.aborted, true);
  assert.equal(requests.length, 1);
});

test("生成失敗のSSEイベントを成功に置き換えず中継する", async (t) => {
  for (const text of [frame({ type: "error", code: "server_error", message: "Temporary failure" }),
    frame({ type: "response.created", response: response() }) + frame({ type: "response.failed", response: response({ status: "failed", error: { code: "server_error", message: "Temporary failure" } }) })]) {
    const { base } = await app(t, () => streamResponse(text));
    const result = await send(base, "POST", "", { ...creation, stream: true });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), text);
  }
});

test("保存しない応答でも手元のitemsと暗号化された文脈を渡して継続する", async (t) => {
  const input = [{ role: "user", content: "以前の入力" }, { type: "reasoning", id: "rs_a", encrypted_content: "encrypted", summary: [] },
    ...output, { type: "compaction", id: "cmp_a", encrypted_content: "compact" }, { role: "user", content: "続き" }];
  const { base, responseOwners, requests } = await app(t, () => Response.json(response({ store: false })));
  const result = await client(base).create({ model, input, store: false, include: ["reasoning.encrypted_content"] });
  assert.equal(result.store, false);
  assert.deepEqual(requests[0].body.input, input);
  assert.equal(responseOwners.size, 0);
  await assert.rejects(client(base).retrieve("resp_a"), { status: 404 });
});

test("store=falseのストリーミングで受け取ったitemsをクライアントへ渡す", async (t) => {
  const text = frame({ type: "response.created", response: response({ store: false }) }) + frame({ type: "response.completed", response: response({ store: false }) });
  const { base, responseOwners } = await app(t, () => streamResponse(text));
  const result = await send(base, "POST", "", { ...creation, stream: true, store: false });
  assert.equal(await result.text(), text);
  assert.equal(responseOwners.size, 0);
});

test("未対応の共有リソース参照やコンテナツールを明示的に拒否する", async (t) => {
  const { base, requests } = await app(t, () => assert.fail("Unsupported access must not be sent upstream"));
  for (const fields of [{ conversation: "conv_other" }, { prompt: { id: "pmpt_other" } }, { model: "other" },
    { input: [{ id: "msg_other" }] }, { input: [{ type: "item_reference", id: "msg_other" }] },
    { input: [{ type: "reasoning", id: "rs_other", summary: [] }] },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_other" }] }] },
    { tools: [{ type: "file_search", vector_store_ids: ["vs_other"] }] },
    { tools: [{ type: "code_interpreter", container: { type: "auto" } }] }, { tools: [{ type: "shell" }] },
    { tool_choice: { type: "code_interpreter" } }, { tool_choice: { type: "allowed_tools", tools: [{ type: "shell" }] } },
    { stream: "true" }, { unsupported: true }]) {
    await assert.rejects(client(base).create({ ...creation, ...fields }), { status: 400 });
  }
  assert.equal(requests.length, 0);
});

test("同じ利用者の再送キーを維持し他人のキーと分離する", async (t) => {
  const ids = new Map();
  const { base, requests } = await app(t, ({ headers }) => {
    const key = headers.get("idempotency-key");
    if (!ids.has(key)) ids.set(key, `resp_${ids.size + 1}`);
    return Response.json(response({ id: ids.get(key) }));
  });
  const options = { headers: { "Idempotency-Key": "same-client-key" } };
  assert.equal((await client(base).create(creation, options)).id, "resp_1");
  assert.equal((await client(base).create(creation, options)).id, "resp_1");
  assert.equal((await client(base, "user-b").create(creation, options)).id, "resp_2");
  assert.equal(requests[0].headers.get("idempotency-key"), requests[1].headers.get("idempotency-key"));
  assert.notEqual(requests[0].headers.get("idempotency-key"), requests[2].headers.get("idempotency-key"));
});

test("圧縮と入力トークン数を公式のリソースとして返す", async (t) => {
  const compacted = { id: "resp_compact", object: "response.compaction", created_at: 1, output: [{ type: "compaction", id: "cmp_a", encrypted_content: "encrypted" }] };
  const { base, requests } = await app(t, ({ path }) => Response.json(path.endsWith("/compact") ? compacted : { object: "response.input_tokens", input_tokens: 123 }), { responseOwners: owners() });
  const api = client(base);
  assert.deepEqual(await api.compact(creation), compacted);
  assert.deepEqual(await api.inputTokens.count({ ...creation, previous_response_id: "resp_a" }), { object: "response.input_tokens", input_tokens: 123 });
  assert.deepEqual(requests.map(({ path }) => path), ["/v1/responses/compact", "/v1/responses/input_tokens"]);
});

test("本人の応答を削除し以後の取得で公式の404を返す", async (t) => {
  let deleted = false;
  const { base, requests } = await app(t, ({ method }) => {
    if (method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    return Response.json({ error: { message: "Response not found", type: "invalid_request_error", code: "not_found" } }, { status: 404 });
  }, { responseOwners: owners() });
  await client(base).delete("resp_a");
  assert.equal(deleted, true);
  await assert.rejects(client(base).retrieve("resp_a"), { status: 404, code: "not_found" });
  assert.equal(requests.length, 2);
});

test("上流エラーの分類と再試行情報を返し生成を自動再送しない", async (t) => {
  const { base, requests } = await app(t, () => Response.json({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "private diagnostic" } },
    { status: 429, headers: { "retry-after": "10", "x-request-id": "request_failure" } }));
  await assert.rejects(client(base).create(creation), (error) => {
    assert.equal(error.status, 429); assert.equal(error.code, "rate_limit_exceeded");
    assert.equal(error.headers.get("retry-after"), "10");
    assert.equal(error.headers.get("x-request-id"), "request_failure");
    return true;
  });
  assert.equal(requests.length, 1);
});

test("所有者を保存できない場合は応答を公開せず503を返す", async (t) => {
  for (const stream of [false, true]) {
    const { base } = await app(t, () => stream ? streamResponse(frame({ type: "response.created", response: response() })) : Response.json(response()), {
      responseStore: { owns: async () => false, save: async () => { throw Object.assign(new Error("Storage down"), { status: 503 }); } },
    });
    const result = await send(base, "POST", "", { ...creation, stream });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.type, "server_error");
  }
});

test("所有者を照合できない場合は取得と会話継続を停止する", async (t) => {
  const { base, requests } = await app(t, () => assert.fail("Ownership verification must succeed first"), {
    responseStore: { owns: async () => { throw Object.assign(new Error("Storage down"), { status: 503 }); } },
  });
  await assert.rejects(client(base).retrieve("resp_a"), { status: 503 });
  await assert.rejects(client(base).create({ ...creation, previous_response_id: "resp_a" }), { status: 503 });
  assert.equal(requests.length, 0);
});

test("作成時の上流応答が不正なら所有者を登録せず502を返す", { timeout: 3000 }, async (t) => {
  for (const upstream of [Response.json({ id: "foreign", object: "response" }),
    streamResponse(frame({ type: "response.created", response: { id: "foreign", object: "response" } })),
    streamResponse(frame({ type: "response.output_text.delta", delta: "unexpected" })),
    streamResponse("data: {malformed-json}\r\n\r\n"),
    streamResponse(""),
    streamResponse("data: [DONE]\r\n\r\n")]) {
    const { base, responseOwners } = await app(t, () => upstream);
    const result = await send(base, "POST", "", { ...creation, stream: upstream.headers.get("content-type").startsWith("text/event-stream") });
    assert.equal(result.status, 502);
    assert.equal(responseOwners.size, 0);
  }
});

test("不正なクエリと別オリジンからの変更操作を拒否する", async (t) => {
  const { base } = await app(t, () => assert.fail("Invalid requests must stop locally"), { responseOwners: owners() });
  for (const query of ["user_id=other", "stream=1", "starting_after=-1", "starting_after=9007199254740993", "stream=true&stream=false"]) {
    assert.equal((await send(base, "GET", `/resp_a?${query}`)).status, 400);
  }
  for (const [method, path, body] of [["POST", "", creation], ["POST", "/resp_a/cancel"], ["DELETE", "/resp_a"]]) {
    assert.equal((await send(base, method, path, body, { Origin: "https://untrusted.example" })).status, 403);
  }
  assert.equal((await send(base, "POST", "/resp_a/cancel", { unexpected: true })).status, 400);
});

test("SupabaseでResponse所有者を本人とIDの両方で照合し同じ所有者の保存を再試行する", async () => {
  const requests = [];
  let duplicate = false, found = true;
  const database = createClient("https://auth-test.supabase.co", "sb_secret_test", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, options) => {
      requests.push({ url: new URL(url), method: options.method, body: options.body });
      if (options.method === "POST") return duplicate ? Response.json({ code: "23505", message: "duplicate" }, { status: 409 }) : new Response(null, { status: 201 });
      return Response.json(found ? { id: "resp_a" } : null);
    } },
  });
  const store = new SupabaseResponseStore(database);
  assert.equal(await store.owns(USER_A, "resp_a"), true);
  assert.equal(requests[0].url.searchParams.get("user_id"), `eq.${USER_A}`);
  assert.equal(requests[0].url.searchParams.get("id"), "eq.resp_a");
  await store.save(USER_A, "resp_a");
  assert.deepEqual(JSON.parse(requests[1].body), { user_id: USER_A, id: "resp_a" });
  duplicate = true;
  await store.save(USER_A, "resp_a");
  found = false;
  await assert.rejects(store.save(USER_B, "resp_a"), { status: 503 });
});
