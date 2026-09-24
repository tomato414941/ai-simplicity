import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import { app } from "./helpers.js";
import { readEvents } from "../shared/agent-session.js";

const models = { claude: { provider: "anthropic", model: "claude-opus-5-5" } };
const body = { model: "claude", input: "こんにちは", stream: true };
const client = (base) => new OpenAI({ apiKey: "local-test", baseURL: base + "/v1", maxRetries: 0 }).responses;
const message = (fields = {}) => ({ id: "msg_native", type: "message", role: "assistant", model: models.claude.model,
  content: [], stop_reason: null, usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 0 }, ...fields });
const frame = (event) => "event: " + event.type + "\r\ndata: " + JSON.stringify(event) + "\r\n\r\n";
const bytes = (event) => new TextEncoder().encode(frame(event));
const streamResponse = (events) => new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream", "request-id": "native-request" } });
const start = { type: "message_start", message: message() };
const ending = (reason = "end_turn") => [
  { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 7 } }, { type: "message_stop" },
];
const functionTool = { type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } };

test("Anthropicの逐次テキストとツール引数をResponsesのイベントに変換する", { timeout: 3000 }, async (t) => {
  let output;
  const { base, responseRecords, observations } = await app(t, () => new Response(new ReadableStream({ start(controller) {
    output = controller;
    controller.enqueue(bytes(start));
  } }), { headers: { "content-type": "text/event-stream", "request-id": "native-request" } }), { models });
  const upstream = await client(base).create({ ...body, tools: [functionTool] }).asResponse();
  assert.equal(upstream.headers.get("x-request-id"), "native-request");
  const events = readEvents(upstream.body), received = [];
  received.push((await events.next()).value, (await events.next()).value);
  assert.deepEqual(received.map(({ type }) => type), ["response.created", "response.in_progress"]);
  const id = received[0].response.id;
  assert.ok(id.startsWith("resp_anthropic_"));
  assert.equal(responseRecords.get(id).response.status, "in_progress");
  const sources = [
    { type: "ping" },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "こんにちは" } },
  ];
  for (const byte of new TextEncoder().encode(sources.map(frame).join(""))) output.enqueue(Uint8Array.of(byte));
  received.push((await events.next()).value, (await events.next()).value, (await events.next()).value);
  assert.equal(received.at(-1).delta, "こんにちは");
  assert.equal(responseRecords.get(id).response.status, "in_progress");
  for (const event of [
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"東京"}' } },
    { type: "content_block_stop", index: 1 }, ...ending("tool_use"),
  ]) output.enqueue(bytes(event));
  output.close();
  for await (const event of events) received.push(event);
  assert.deepEqual(received.map(({ sequence_number }) => sequence_number), received.map((_, index) => index));
  const completed = received.at(-1);
  assert.equal(completed.type, "response.completed");
  assert.equal(completed.response.model, "claude");
  assert.equal(completed.response.id, id);
  assert.equal(completed.response.output[0].content[0].text, "こんにちは");
  assert.equal(completed.response.output[1].call_id, "toolu_1");
  assert.equal(completed.response.output[1].arguments, '{"q":"東京"}');
  assert.deepEqual(completed.response.usage, { input_tokens: 15, output_tokens: 7, total_tokens: 22,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 0 } });
  assert.deepEqual(responseRecords.get(id).response, completed.response);
  assert.equal(observations.filter(({ kind }) => kind === "usage").length, 2);
  assert.deepEqual((await client(base).retrieve(id)).output, completed.response.output);
});

test("Anthropicのツール呼び出しと結果を対応させて会話を継続する", async (t) => {
  let count = 0;
  const { base, requests } = await app(t, () => Response.json(message(++count === 1 ? {
    content: [{ type: "tool_use", id: "toolu_lookup", name: "lookup", input: { q: "東京" } }], stop_reason: "tool_use",
  } : { id: "msg_next", content: [{ type: "text", text: "晴れです" }], stop_reason: "end_turn" })), { models });
  const api = client(base);
  const first = await api.create({ model: "claude", instructions: "Use tools.", input: "天気は？", tools: [functionTool],
    tool_choice: { type: "function", name: "lookup" }, parallel_tool_calls: false });
  assert.equal(first.output[0].type, "function_call");
  const second = await api.create({ model: "claude", previous_response_id: first.id, tools: [functionTool],
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "晴れ" }] });
  assert.equal(second.output_text, "晴れです");
  assert.deepEqual(requests[0].body.system, [{ type: "text", text: "Use tools." }]);
  assert.deepEqual(requests[0].body.tool_choice, { type: "tool", name: "lookup", disable_parallel_tool_use: true });
  assert.deepEqual(requests[1].body.messages.slice(1), [
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_lookup", name: "lookup", input: { q: "東京" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_lookup", content: [{ type: "text", text: "晴れ" }] }] },
  ]);
});

test("Anthropicのトークン上限による打ち切りをincompleteとして返す", async (t) => {
  const { base } = await app(t, ({ body }) => body.stream ? streamResponse([start, ...ending("max_tokens")])
    : Response.json(message({ content: [{ type: "text", text: "途中" }], stop_reason: "max_tokens" })), { models });
  const complete = await client(base).create({ ...body, stream: false, max_output_tokens: 1 });
  assert.equal(complete.status, "incomplete");
  assert.deepEqual(complete.incomplete_details, { reason: "max_output_tokens" });
  const events = [];
  for await (const event of await client(base).create({ ...body, store: false })) events.push(event);
  assert.equal(events.at(-1).type, "response.incomplete");
});

test("Anthropicの途中エラーをクライアントへ伝え結果を未確定のまま保持する", async (t) => {
  const { base, requests, observations } = await app(t, () => streamResponse([start,
    { type: "error", error: { type: "overloaded_error", message: "Sensitive upstream detail" } },
  ]), { models });
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of await client(base).create(body)) seen.push(event);
  }, (error) => error.code === "overloaded_error" && !error.message.includes("Sensitive"));
  assert.deepEqual(seen.map(({ type }) => type), ["response.created", "response.in_progress"]);
  assert.equal(observations.filter(({ kind }) => kind === "cost").at(-1).status, "unknown");
  await assert.rejects(client(base).retrieve(seen[0].response.id), { status: 503, code: "response_unavailable" });
  assert.equal(requests.length, 1);
});

test("Anthropicの完了前の切断を通信エラーとして扱う", async (t) => {
  const { base, responseRecords } = await app(t, () => streamResponse([start]), { models });
  await assert.rejects(async () => { for await (const event of await client(base).create(body)) assert.notEqual(event.type, "response.completed"); });
  assert.equal([...responseRecords.values()][0].response.status, "in_progress");
});

test("利用者の停止操作をAnthropicへの接続中断として伝える", { timeout: 3000 }, async (t) => {
  let signal;
  const { base, requests } = await app(t, (request) => {
    signal = request.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes(start));
      signal.addEventListener("abort", () => controller.error(new Error("Connection aborted")), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  }, { models });
  const stream = await client(base).create(body), events = stream[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.type, "response.created");
  stream.controller.abort();
  await events.return();
  for (let attempt = 0; !signal.aborted && attempt < 100; attempt++) await delay(2);
  assert.equal(signal.aborted, true);
  assert.equal(requests.length, 1);
});

test("Anthropicの入力トークン数を生成せず公式の操作に変換する", async (t) => {
  const { base, requests } = await app(t, () => Response.json({ input_tokens: 123 }), { models });
  const counted = await client(base).inputTokens.count({ model: "claude", input: "Hello", instructions: "Be brief" });
  assert.deepEqual(counted, { object: "response.input_tokens", input_tokens: 123 });
  assert.equal(requests[0].path, "/v1/messages/count_tokens");
  assert.deepEqual(requests[0].body.messages, [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
});

test("Anthropicの不正な利用量を確定値として記録せず拒否する", async (t) => {
  const { base, observations } = await app(t, () => Response.json(message({ stop_reason: "end_turn", usage: { input_tokens: -1, output_tokens: 0 } })), { models });
  await assert.rejects(client(base).create({ ...body, stream: false }), { status: 502 });
  assert.equal(observations.length, 0);
});
