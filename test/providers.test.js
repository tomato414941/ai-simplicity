import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { app } from "./helpers.js";
import { responseConfiguration } from "../src/response-providers.js";
import { UserResponses } from "../src/user-responses.js";

const models = {
  gpt: { provider: "openai", model: "gpt-6-astra" },
  router: { provider: "openrouter", model: "openai/gpt-6-astra" },
  claude: { provider: "anthropic", model: "claude-opus-5-5" },
};
const client = (base, key = "local-test") => new OpenAI({ apiKey: key, baseURL: base + "/v1", maxRetries: 0 });
const native = (id, text, model, fields = {}) => ({ id, object: "response", model, created_at: 1, status: "completed", store: true,
  previous_response_id: null, output: [{ type: "message", id: "msg_" + id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }, ...fields });
const anthropic = (id, text, model) => ({ id, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn",
  usage: { input_tokens: 8, cache_read_input_tokens: 2, output_tokens: 3 } });

test("認証した利用者へ選択可能なモデルを公開する", async (t) => {
  const { base, requests } = await app(t, () => assert.fail("Listing models is local"), { models });
  assert.equal((await fetch(base + "/v1/models")).status, 401);
  const result = await client(base).models.list();
  assert.deepEqual(result.data.map(({ id, owned_by }) => [id, owned_by]), [["gpt", "openai"], ["router", "openrouter"], ["claude", "anthropic"]]);
  assert.equal(requests.length, 0);
});

test("3社への同時生成を個々の接続先・モデル・認証情報に振り分ける", { timeout: 3000 }, async (t) => {
  const pending = [];
  const { base, requests, responseRecords } = await app(t, (request) => new Promise((resolve) => {
    pending.push({ request, resolve });
    if (pending.length === 3) for (const { request: { host, body }, resolve } of pending) resolve(Response.json(host === "api.anthropic.com"
      ? anthropic("resp_same", "Claude", body.model) : native("resp_same", host, body.model)));
  }), { models });
  const results = await Promise.all(Object.keys(models).map((model) => client(base).responses.create({ model, input: "Hi" })));
  assert.equal(new Set(results.map(({ id }) => id)).size, 3);
  assert.deepEqual(results.map(({ model }) => model), ["gpt", "router", "claude"]);
  const byHost = new Map(requests.map((request) => [request.host, request]));
  assert.equal(byHost.get("api.openai.com").headers.get("authorization"), "Bearer test-key");
  assert.equal(byHost.get("openrouter.ai").headers.get("authorization"), "Bearer router-key");
  assert.equal(byHost.get("api.anthropic.com").headers.get("x-api-key"), "anthropic-key");
  assert.equal(byHost.get("openrouter.ai").body.model, "openai/gpt-6-astra");
  assert.equal(byHost.get("openrouter.ai").body.store, false);
  assert.deepEqual(byHost.get("openrouter.ai").body.provider, { allow_fallbacks: false, require_parameters: true });
  assert.equal(byHost.get("api.anthropic.com").body.model, "claude-opus-5-5");
  assert.deepEqual(results.map(({ id }) => responseRecords.get(id).provider), ["openai", "openrouter", "anthropic"]);
});

test("OpenAI・OpenRouter・Anthropicをまたいで会話を続け別端末から履歴を取得する", async (t) => {
  let index = 0;
  const firstApp = await app(t, ({ host, body }) => {
    const number = ++index;
    return Response.json(host === "api.anthropic.com" ? anthropic("message_" + number, "Answer " + number, body.model)
      : native("resp_" + number, "Answer " + number, body.model));
  }, { models });
  const api = client(firstApp.base).responses;
  const a = await api.create({ model: "gpt", input: "First" });
  const b = await api.create({ model: "router", input: "Second", previous_response_id: a.id });
  const c = await api.create({ model: "claude", input: "Third", previous_response_id: b.id });
  const d = await api.create({ model: "gpt", input: "Fourth", previous_response_id: c.id });
  assert.equal(b.previous_response_id, a.id);
  assert.equal(c.previous_response_id, b.id);
  assert.equal(d.previous_response_id, c.id);
  const [openai, router, claude, back] = firstApp.requests;
  assert.equal(router.body.previous_response_id, undefined);
  assert.equal(back.body.previous_response_id, undefined);
  assert.deepEqual(router.body.input.map((item) => item.content[0]?.text ?? item.content), ["First", "Answer 1", "Second"]);
  assert.deepEqual(claude.body.messages.map((item) => item.content[0].text), ["First", "Answer 1", "Second", "Answer 2", "Third"]);
  assert.equal(back.body.input.length, 7);
  assert.equal(openai.body.input, "First");
  const secondApp = await app(t, () => assert.fail("Saved conversation reads do not need a provider"), {
    models, responseOwners: firstApp.responseOwners, responseRecords: firstApp.responseRecords,
  });
  assert.deepEqual(await client(secondApp.base).responses.retrieve(c.id).asResponse().then((r) => r.json()), firstApp.responseRecords.get(c.id).response);
  const inputs = await client(secondApp.base).responses.inputItems.list(d.id, { order: "asc" });
  assert.deepEqual(inputs.data.map(({ content }) => content[0].text), ["First", "Answer 1", "Second", "Answer 2", "Third", "Answer 3", "Fourth"]);
  // Deleting the parent does not erase a child's captured input history.
  await api.delete(b.id);
  assert.equal((await api.inputItems.list(c.id)).data.length, 5);
});

test("接続先を変えても別利用者の応答の取得・継続・削除を拒否する", async (t) => {
  const { base, requests } = await app(t, ({ body }) => Response.json(native("remote_id", "Private", body.model)), { models });
  const a = await client(base).responses.create({ model: "router", input: "Private" });
  const before = requests.length;
  const b = client(base, "user-b").responses;
  for (const operation of [() => b.retrieve(a.id), () => b.inputItems.list(a.id), () => b.delete(a.id), () => b.cancel(a.id),
    ...Object.keys(models).map((model) => () => b.create({ model, input: "Continue", previous_response_id: a.id }))]) {
    await assert.rejects(operation, { status: 404, code: "not_found" });
  }
  assert.equal(requests.length, before);
});

test("保存しない生成でも原価・利用量を記録しユーザー請求とは分離する", async (t) => {
  const { base, responseRecords, observations } = await app(t, ({ body }) => Response.json(native("remote_id", "Text", body.model, {
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, cost: 0.000012345 }, store: false,
  })), { models, billing: { settle: () => assert.fail("Supplier cost is not a user charge") } });
  const created = await client(base).responses.create({ model: "router", input: "Hi", store: false });
  assert.equal(created.store, false);
  assert.equal(responseRecords.size, 0);
  await assert.rejects(client(base).responses.retrieve(created.id), { status: 404 });
  assert.deepEqual(observations.filter((item) => item.kind === "usage").map(({ metric, quantity, unit }) => [metric, quantity, unit]),
    [["input_tokens", "10", "token"], ["output_tokens", "3", "token"]]);
  const costs = observations.filter((item) => item.kind === "cost");
  assert.equal(costs[0].amount, null);
  assert.equal(costs[0].status, "unknown");
  assert.equal(costs[1].amount, "0.000012345");
  assert.equal(costs[1].source, "openrouter");
  assert.equal(costs[1].supersedes_id, costs[0].id);
});

test("保存済みの応答を再取得して記録に失敗した利用量を補う", async (t) => {
  let fail = true, recorded = 0;
  const { base, responseRecords, requests } = await app(t, ({ body }) => Response.json(native("remote_id", "Text", body.model)), {
    models, billing: { recordUsage: async () => { if (fail) throw Object.assign(new Error("DB unavailable"), { status: 503 }); recorded++; } },
  });
  await assert.rejects(client(base).responses.create({ model: "router", input: "Hi" }), { status: 503 });
  const [id] = responseRecords.keys();
  fail = false;
  assert.equal((await client(base).responses.retrieve(id)).status, "completed");
  assert.equal(recorded, 2);
  assert.equal(requests.length, 1);
});

test("未対応の実行機能と予約済みツール名を生成前に拒否する", async (t) => {
  const { base, requests } = await app(t, () => assert.fail("Unsupported features must be rejected before inference"), { models });
  const api = client(base).responses;
  for (const body of [
    { model: "router", background: true }, { model: "router", context_management: [] },
    { model: "router", tools: [{ type: "web_search" }] },
    { model: "router", tools: [{ type: "function", name: "openrouter:shell", parameters: {} }] },
    { model: "router", tool_choice: { type: "function", name: "openrouter:shell" } },
    { model: "claude", reasoning: { effort: "low" } }, { model: "claude", background: true },
    { model: "claude", tools: [{ type: "function", name: "strict_tool", parameters: {}, strict: true }] },
    { model: "claude", text: { format: { type: "json_object" } } },
    { model: "claude", input: [{ role: "user", content: "Hi" }, { role: "system", content: "Inserted later" }] },
  ]) await assert.rejects(api.create({ input: "Hi", ...body }), { status: 400 });
  await assert.rejects(api.create({ model: "router", input: "Hi" }, { headers: { "Idempotency-Key": "attempt" } }), { status: 400 });
  await assert.rejects(api.compact({ model: "router", input: "Hi" }), { status: 400 });
  await assert.rejects(api.inputTokens.count({ model: "router", input: "Hi" }), { status: 400 });
  assert.equal(requests.length, 0);
});

test("暗号化された圧縮文脈を別モデルへ渡す場合は明示的に拒否する", async (t) => {
  const { base, requests } = await app(t, ({ body }) => Response.json(native("resp_compacted", "Text", body.model, {
    output: [{ type: "compaction", id: "cmp_test", encrypted_content: "private-provider-state" }],
  })), { models });
  const first = await client(base).responses.create({ model: "gpt", input: "Long context" });
  await assert.rejects(client(base).responses.create({ model: "claude", input: "Continue", previous_response_id: first.id }), { status: 400 });
  assert.equal(requests.length, 1);
});

test("モデル設定の接続先と認証情報を検証する", () => {
  const credentials = { OPENAI_API_KEY: "test-key", OPENROUTER_API_KEY: "router-key", ANTHROPIC_API_KEY: "anthropic-key" };
  const configured = responseConfiguration({ ...credentials, RESPONSES_MODELS: JSON.stringify(models) });
  assert.deepEqual([...configured.models.keys()], ["gpt", "router", "claude"]);
  for (const configuration of [{ x: { provider: "unknown", model: "x" } }, { x: { provider: "openai", model: "x", url: "http://untrusted" } }, []]) {
    assert.throws(() => responseConfiguration({ ...credentials, RESPONSES_MODELS: JSON.stringify(configuration) }), /configuration|model map/);
  }
  assert.throws(() => responseConfiguration({ OPENAI_API_KEY: "test", RESPONSES_MODELS: JSON.stringify(models) }), /OPENROUTER_API_KEY/);
});

test("モデルの公開を終了しても作成時の接続先で保存済み応答を削除する", async (t) => {
  const firstApp = await app(t, ({ body }) => Response.json(native("resp_original", "Text", body.model)), { models });
  const created = await client(firstApp.base).responses.create({ model: "gpt", input: "Hi" });
  const nextApp = await app(t, () => new Response(null, { status: 204 }), {
    models: { router: models.router }, responseOwners: firstApp.responseOwners, responseRecords: firstApp.responseRecords,
  });
  await client(nextApp.base).responses.delete(created.id);
  assert.equal(nextApp.requests.length, 1);
  assert.equal(nextApp.requests[0].host, "api.openai.com");
  assert.equal(nextApp.requests[0].path, "/v1/responses/resp_original");
});

test("同じ接続先でも異なるモデルには移植可能な履歴を渡す", async (t) => {
  let count = 0;
  const { base, requests } = await app(t, ({ body }) => Response.json(native("resp_" + ++count, "Text", body.model)), {
    models: { first: models.gpt, second: { provider: "openai", model: "another-model" } },
  });
  const first = await client(base).responses.create({ model: "first", input: "Hi" });
  await client(base).responses.create({ model: "second", input: "Continue", previous_response_id: first.id });
  assert.equal(requests[1].body.previous_response_id, undefined);
  assert.equal(requests[1].body.input.length, 3);
});

test("ステートレス接続先の認証情報を外した後も本人の保存データを削除する", async () => {
  let removed;
  const responses = new UserResponses({ providers: new Map(), models: new Map(), store: {
    read: async (user, id) => ({ id, user_id: user, provider: "openrouter", upstream_id: "native" }),
    delete: async (user, id) => { removed = [user, id]; },
  } });
  assert.equal((await responses.delete("user", "resp_local")).status, 204);
  assert.deepEqual(removed, ["user", "resp_local"]);
});
