import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { Billing, priceQuantity } from "../src/billing.js";
import { app, USER_A, USER_B } from "./helpers.js";

const ID = "33333333-3333-4333-8333-333333333333";
const TIME = "2026-09-21T00:00:00Z";
const measurement = (extra = {}) => ({ source: "storage", reference: "object:1:day:1", user_id: USER_A,
  metric: "stored_data", unit: "byte_hour", quantity: "123.456789123", status: "final", occurred_at: TIME, ...extra });
const cost = (extra = {}) => ({ source: "supplier", reference: "invoice:1:line:1", user_id: USER_A,
  attribution: "user", amount: "0.000000001", currency: "USD", status: "final", occurred_at: TIME, ...extra });

function api(handler) {
  const requests = [];
  const client = createClient("https://billing.example.test", "sb_secret_test", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => {
      const request = { url: new URL(url), method: options.method, body: options.body ? JSON.parse(options.body) : null, signal: options.signal };
      requests.push(request);
      return handler(request);
    } },
  });
  return { billing: new Billing(client), requests };
}

test("利用量と自社単価から精度を維持してクレジットを計算する", () => {
  assert.equal(priceQuantity("0.1", "0.2"), "1");
  assert.equal(priceQuantity("10", "0.1"), "1");
  assert.equal(priceQuantity("1000000000", "0.000000001"), "1");
  assert.equal(priceQuantity("9007199254740993", "1"), "9007199254740993");
  assert.equal(priceQuantity("9223372036854775807", "1"), "9223372036854775807");
  assert.equal(priceQuantity("10", "0"), "0");
  for (const value of [1, -1, "-1", "NaN", "Infinity", "1e2", "01", "0.0000000001", null]) {
    assert.throws(() => priceQuantity(value, "1"), { status: 400 });
  }
  assert.throws(() => priceQuantity("9223372036854775807", "2"), { status: 400 });
});

test("異なる発生元の利用実績と原価を独立した明細として保存する", async () => {
  const { billing, requests } = api(() => Response.json(ID));
  assert.equal(await billing.recordUsage(measurement()), ID);
  assert.equal(await billing.recordCost(cost()), ID);
  await billing.recordCost(cost({ reference: "server:month:1", user_id: null, attribution: "shared", amount: "20" }));
  await billing.recordUsage(measurement({ reference: "pending", quantity: null, status: "unknown" }));
  await billing.recordCost(cost({ reference: "pending", amount: null, status: "unknown" }));
  assert.deepEqual(requests.map((r) => r.url.pathname.split("/").at(-1)), [
    "billing_record_usage", "billing_record_cost", "billing_record_cost", "billing_record_usage", "billing_record_cost",
  ]);
  assert.equal(requests[0].body.p_record.quantity, "123.456789123");
  assert.equal(requests[1].body.p_record.amount, "0.000000001");
  assert.equal(requests[2].body.p_record.attribution, "shared");
  assert.equal(requests[3].body.p_record.quantity, null);
  assert.equal(requests[4].body.p_record.amount, null);
});

test("会計入力の単位・帰属・時刻・精度を検証する", () => {
  const { billing } = api(() => assert.fail("Invalid records must be rejected before storage"));
  for (const change of [{ quantity: 10 }, { quantity: "-1" }, { quantity: "0.0000000001" },
    { quantity: null }, { status: "unknown" }, { unit: "" }, { user_id: "bad" }, { extra: true },
    { occurred_at: "2026-09-21" }, { period_end: "2026-09-20T00:00:00Z" }, { supersedes_id: "bad" }]) {
    assert.throws(() => billing.recordUsage(measurement(change)), { status: 400 });
  }
  for (const change of [{ amount: 0.1 }, { amount: null }, { status: "unknown" }, { currency: "usd" },
    { attribution: "shared" }, { user_id: null }, { usage_id: "bad" }, { amount: "1e-9" }]) {
    assert.throws(() => billing.recordCost(cost(change)), { status: 400 });
  }
  for (const amount of [10, "0", "-1", "1.5", "9223372036854775808"]) {
    assert.throws(() => billing.grant({ userId: USER_A, source: "app", reference: "trial", amount, reason: "trial" }), { status: 400 });
  }
  assert.throws(() => billing.reserve({ userId: USER_A, reference: "a", amount: "1", pricing: {}, reviewAt: TIME }), { status: 400 });
});

test("残高の変更を文字列のクレジット額と価格版を使ってDBへ渡す", async () => {
  const { billing, requests } = api(() => Response.json(ID));
  await billing.grant({ userId: USER_A, source: "app", reference: "trial:a", amount: "9007199254740993", reason: "trial" });
  await billing.reserve({ userId: USER_A, reference: "purchase:1", amount: "10", pricing: { version: "v1", unit_price: "0.25" }, reviewAt: TIME });
  await billing.settle({ userId: USER_A, reservationId: ID, amount: "4" });
  await billing.release({ userId: USER_A, reservationId: ID, reason: "not_started" });
  await billing.refund({ userId: USER_A, chargeId: ID, reason: "service_failure" });
  assert.equal(requests[0].body.p_credits, "9007199254740993");
  assert.deepEqual(requests[1].body.p_pricing, { version: "v1", unit_price: "0.25" });
  assert.equal(requests[2].body.p_credits, "4");
  assert.equal(requests[3].body.p_reason, "not_started");
  assert.equal(requests[4].body.p_charge_id, ID);
});

test("DBの残高不足・競合・停止を識別可能なAPIエラーに変換する", async () => {
  for (const [code, message, status] of [["P0001", "insufficient_credits", 402], ["P0001", "idempotency_conflict", 409],
    ["23505", "duplicate", 409], ["P0002", "missing", 404], ["22023", "invalid", 400], ["XX000", "private SQL details", 503]]) {
    const { billing } = api(() => Response.json({ code, message }, { status: 500 }));
    await assert.rejects(billing.balance(USER_A), { status });
  }
});

test("利用明細を本人の範囲で新しい順にページングする", async () => {
  const { billing, requests } = api(({ url }) => url.searchParams.get("select") === "id,created_at"
    ? Response.json({ id: ID, created_at: TIME })
    : Response.json([{ id: "first" }, { id: "second" }, { id: "third" }]));
  assert.deepEqual(await billing.history(USER_A, { limit: 2, after: ID }), {
    data: [{ id: "first" }, { id: "second" }], has_more: true, next: "second",
  });
  for (const request of requests) assert.equal(request.url.searchParams.get("user_id"), `eq.${USER_A}`);
  assert.equal(requests[1].url.searchParams.get("limit"), "3");
  assert.equal(requests[1].url.searchParams.get("order"), "created_at.desc,id.desc");
  assert.match(requests[1].url.searchParams.get("or"), /created_at.lt/);
  const missing = api(() => Response.json(null)).billing;
  await assert.rejects(missing.history(USER_A, { after: ID }), { status: 400 });
});

test("残高と明細のAPIを認証した本人のみに公開する", async (t) => {
  const readers = [];
  const { base } = await app(t, () => assert.fail("Billing reads must not call the AI provider"), { billing: {
    balance: async (userId) => { readers.push(userId); return { unit: "credit", balance: userId === USER_A ? "100" : "20", reserved: "0", available: "20" }; },
    history: async (userId) => { readers.push(userId); return { data: [{ id: userId }], has_more: false, next: null }; },
  } });
  for (const path of ["/api/billing", "/api/billing/entries"]) {
    assert.equal((await fetch(base + path)).status, 401);
    for (const [token, user] of [["local-test", USER_A], ["user-b", USER_B]]) {
      const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      const value = await response.json();
      if (path.endsWith("entries")) assert.equal(value.data[0].id, user);
      else assert.equal(value.balance, user === USER_A ? "100" : "20");
      assert.equal(readers.at(-1), user);
    }
    const forged = await fetch(base + path + "?user_id=" + USER_B, { headers: { Authorization: "Bearer local-test" } });
    assert.equal(forged.status, 400);
    assert.equal((await fetch(base + path, { method: "POST", headers: { Authorization: "Bearer local-test" } })).status, 404);
  }
});

test("残高読み取りでストレージ障害をゼロ残高に置き換えずに伝える", async (t) => {
  const { base } = await app(t, () => assert.fail(), { billing: {
    balance: async () => { throw Object.assign(new Error("Private database details"), { status: 503 }); },
  } });
  const response = await fetch(base + "/api/billing", { headers: { Authorization: "Bearer local-test" } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.message, "The request could not be completed.");
});
