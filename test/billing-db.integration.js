import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Billing } from "../src/billing.js";

const exec = promisify(execFile);
const container = `ai-simplicity-billing-test-${randomUUID()}`;
let started = false;
const literal = (value) => value == null ? "null" : `'${String(typeof value === "object" ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
const time = "2026-09-21T00:00:00Z";
const reviewAt = "2099-01-01T00:00:00Z";

async function sql(statement, role = "service_role") {
  const { stdout } = await exec("docker", ["exec", container, "psql", "-X", "-qAt", "-h", "127.0.0.1", "-U", "postgres",
    "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", `set role ${role}; ${statement}`], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
async function value(statement, role) {
  return JSON.parse(await sql(`select to_jsonb(result) from (${statement}) result;`, role));
}
const billing = new Billing({ rpc: async (name, parameters) => {
  try {
    const output = await sql(`select public.${name}(${Object.entries(parameters).map(([key, val]) => `${key} => ${literal(val)}`).join(",")});`);
    return { data: output.startsWith("{") ? JSON.parse(output) : output || null, error: null };
  } catch (error) {
    const match = error.stderr.match(/ERROR:\s+([A-Z0-9]{5}):\s+([^\n]+)/);
    if (!match) throw error;
    return { data: null, error: { code: match[1], message: match[2] } };
  }
} });

async function user(amount = "100") {
  const userId = randomUUID();
  await sql(`insert into auth.users values (${literal(userId)});`, "postgres");
  if (amount !== "0") await billing.grant({ userId, source: "test", reference: userId, amount, reason: "trial" });
  return userId;
}
const reserve = (userId, reference, amount = "60") => billing.reserve({ userId, reference, amount,
  pricing: { version: "test-v1", credits_per_unit: "2" }, reviewAt });

before(async () => {
  await exec("docker", ["run", "--detach", "--rm", "--name", container, "--network", "none",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await exec("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); ready = true; break; }
    catch { await delay(100); }
  }
  assert.ok(ready, "The isolated PostgreSQL instance becomes ready");
  await sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`, "postgres");
  for (const name of ["202609140001_agent_sessions.sql", "202609210001_billing.sql"]) {
    await sql(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"), "postgres");
  }
}, { timeout: 30_000 });

after(async () => { if (started) await exec("docker", ["rm", "--force", container]); });

test("複数の同時予約に対して利用可能な残高だけを確保する", async () => {
  const userId = await user();
  const results = await Promise.allSettled([reserve(userId, "phone"), reserve(userId, "web")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 402);
  assert.deepEqual(await billing.balance(userId), { unit: "credit", balance: "100", reserved: "60", available: "40" });
});

test("付与と予約の再送を一度だけ反映し内容の変更を検出する", async () => {
  const userId = await user("0");
  const grant = { userId, source: "purchase", reference: randomUUID(), amount: "9007199254740993", reason: "purchase" };
  const grants = await Promise.all([billing.grant(grant), billing.grant(grant)]);
  assert.equal(grants[0], grants[1]);
  assert.equal((await billing.balance(userId)).balance, grant.amount);
  const reservations = await Promise.all([reserve(userId, "same"), reserve(userId, "same")]);
  assert.equal(reservations[0], reservations[1]);
  assert.equal((await billing.balance(userId)).reserved, "60");
  await assert.rejects(billing.grant({ ...grant, amount: "10" }), { status: 409 });
  await assert.rejects(reserve(userId, "same", "70"), { status: 409 });
  const other = await user("0");
  await assert.rejects(billing.grant({ ...grant, userId: other }), { status: 409 });
  assert.equal((await billing.balance(other)).balance, "0");
});

test("確保した範囲で精算し未使用分を解放して適用価格を保存する", async () => {
  const userId = await user();
  const reservationId = await reserve(userId, "usage");
  await assert.rejects(billing.settle({ userId, reservationId, amount: "61" }), { status: 400 });
  const charges = await Promise.all([billing.settle({ userId, reservationId, amount: "25" }), billing.settle({ userId, reservationId, amount: "25" })]);
  assert.equal(charges[0], charges[1]);
  assert.deepEqual(await billing.balance(userId), { unit: "credit", balance: "75", reserved: "0", available: "75" });
  const charge = await value(`select credits::text, pricing from public.credit_entries where id = ${literal(charges[0])}`);
  assert.deepEqual(charge, { credits: "-25", pricing: { version: "test-v1", credits_per_unit: "2" } });
  await assert.rejects(billing.settle({ userId, reservationId, amount: "26" }), { status: 409 });
});

test("実行されなかった予約を解放し障害時の消費を一度だけ返還する", async () => {
  const userId = await user();
  const first = await reserve(userId, "not-started");
  await billing.release({ userId, reservationId: first, reason: "not_started" });
  await billing.release({ userId, reservationId: first, reason: "not_started" });
  assert.equal((await billing.balance(userId)).available, "100");
  await assert.rejects(billing.settle({ userId, reservationId: first, amount: "10" }), { status: 409 });
  const second = await reserve(userId, "failed");
  const chargeId = await billing.settle({ userId, reservationId: second, amount: "30" });
  const refunds = await Promise.all([billing.refund({ userId, chargeId, reason: "service_failure" }), billing.refund({ userId, chargeId, reason: "service_failure" })]);
  assert.equal(refunds[0], refunds[1]);
  assert.equal((await billing.balance(userId)).balance, "100");
  assert.equal((await value(`select count(*)::int as count from public.credit_entries where refunds_id = ${literal(chargeId)}`)).count, 1);
});

test("他のユーザーの予約や利用料金への操作を拒否する", async () => {
  const owner = await user(), other = await user();
  const reservationId = await reserve(owner, "private");
  await assert.rejects(billing.settle({ userId: other, reservationId, amount: "10" }), { status: 404 });
  await assert.rejects(billing.release({ userId: other, reservationId, reason: "not_started" }), { status: 404 });
  const chargeId = await billing.settle({ userId: owner, reservationId, amount: "10" });
  await assert.rejects(billing.refund({ userId: other, chargeId, reason: "service_failure" }), { status: 404 });
  assert.equal((await billing.balance(other)).balance, "100");
});

test("原価の訂正を履歴として保持し現在額とユーザー残高を区別する", async () => {
  const userId = await user();
  const original = { source: "storage-provider", reference: randomUUID(), user_id: userId, attribution: "user",
    amount: "0.000000001", currency: "USD", status: "estimated", occurred_at: time };
  const originalId = await billing.recordCost(original);
  assert.equal(await billing.recordCost(original), originalId);
  const replacement = { ...original, reference: randomUUID(), amount: "3.123456789", status: "final", supersedes_id: originalId };
  const replacementId = await billing.recordCost(replacement);
  assert.equal(await billing.recordCost(replacement), replacementId);
  assert.equal((await value(`select count(*)::int as count from public.billing_costs where user_id = ${literal(userId)}`)).count, 2);
  assert.equal((await value(`select amount from public.current_billing_costs where user_id = ${literal(userId)}`)).amount, "3.123456789");
  assert.equal((await billing.balance(userId)).balance, "100");
  await assert.rejects(billing.recordCost({ ...replacement, amount: "4" }), { status: 409 });
  await assert.rejects(billing.recordCost({ ...replacement, reference: randomUUID() }), { status: 409 });
  await assert.rejects(billing.recordCost({ ...replacement, reference: randomUUID(), currency: "JPY" }), { status: 409 });
});

test("利用量の未確定をゼロと区別し確定値へ置換する", async () => {
  const userId = await user();
  const unknown = { source: "provider", reference: randomUUID(), user_id: userId,
    metric: "compute", unit: "second", quantity: null, status: "unknown", occurred_at: time };
  const id = await billing.recordUsage(unknown);
  assert.equal((await value(`select quantity from public.current_billing_usage where user_id = ${literal(userId)}`)).quantity, null);
  const final = { ...unknown, reference: randomUUID(), supersedes_id: id, quantity: "9007199254740993.123456789", status: "final" };
  const finalId = await billing.recordUsage(final);
  assert.equal(await billing.recordUsage(final), finalId);
  assert.equal((await value(`select quantity from public.current_billing_usage where user_id = ${literal(userId)}`)).quantity, final.quantity);
  const other = await user();
  await assert.rejects(billing.recordCost({ source: "provider", reference: randomUUID(), user_id: other, attribution: "user",
    amount: "1", currency: "USD", status: "final", occurred_at: time, usage_id: finalId }), { status: 409 });
});

test("共通の固定費とユーザーに帰属する複数の費用を記録する", async () => {
  const userId = await user();
  const shared = { source: "hosting", reference: randomUUID(), user_id: null, attribution: "shared", amount: "25",
    currency: "USD", status: "final", occurred_at: time, period_end: "2026-10-21T00:00:00Z" };
  const id = await billing.recordCost(shared);
  assert.equal((await value(`select attribution, amount from public.current_billing_costs where id = ${literal(id)}`)).attribution, "shared");
  for (const source of ["model-provider", "search-provider"]) {
    await billing.recordCost({ ...shared, source, reference: randomUUID(), user_id: userId, attribution: "user", amount: "0.5" });
  }
  assert.equal((await value(`select count(*)::int as count from public.current_billing_costs where user_id = ${literal(userId)}`)).count, 2);
  assert.equal((await billing.balance(userId)).balance, "100");
});

test("未帰属の費用を後からユーザーへ帰属させ仕入先の返金も原価に記録する", async () => {
  const userId = await user();
  const pending = { source: "supplier", reference: randomUUID(), user_id: null, attribution: "unassigned", amount: null,
    currency: "USD", status: "unknown", occurred_at: time };
  const id = await billing.recordCost(pending);
  const assigned = { ...pending, reference: randomUUID(), supersedes_id: id, user_id: userId, attribution: "user", amount: "10", status: "final" };
  await billing.recordCost(assigned);
  const refund = await billing.recordCost({ ...assigned, reference: randomUUID(), supersedes_id: null, amount: "-2.5" });
  assert.equal((await value(`select amount from public.current_billing_costs where id = ${literal(refund)}`)).amount, "-2.500000000");
  assert.equal((await value(`select sum(amount::numeric)::text as amount from public.current_billing_costs where user_id = ${literal(userId)}`)).amount, "7.500000000");
  assert.equal((await billing.balance(userId)).balance, "100");
});

test("無料の精算を記録し残高上限を超える付与を履歴ごとロールバックする", async () => {
  const userId = await user("9223372036854775807");
  const reservationId = await reserve(userId, "free");
  const chargeId = await billing.settle({ userId, reservationId, amount: "0" });
  assert.equal((await value(`select credits::text from public.credit_entries where id = ${literal(chargeId)}`)).credits, "0");
  const reference = randomUUID();
  await assert.rejects(billing.grant({ userId, source: "test", reference, amount: "1", reason: "trial" }), { status: 400 });
  assert.equal((await value(`select count(*)::int as count from public.credit_entries where reference = ${literal(reference)}`)).count, 0);
  assert.deepEqual(await billing.balance(userId), { unit: "credit", balance: "9223372036854775807", reserved: "0", available: "9223372036854775807" });
});

test("DBのクライアントロールによる原価参照と残高変更を拒否する", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(sql("select * from public.credit_accounts;", role), /permission denied/);
    await assert.rejects(sql("select * from public.current_billing_costs;", role), /permission denied/);
    await assert.rejects(sql(`select public.credit_balance(${literal(randomUUID())});`, role), /permission denied/);
    await assert.rejects(sql(`select public.credit_grant(${literal(randomUUID())}, 'app', 'forged', 100, 'trial');`, role), /permission denied/);
  }
  await assert.rejects(sql("update public.credit_accounts set balance = 999;"), /permission denied/);
  await assert.rejects(sql("delete from public.billing_costs;"), /permission denied/);
  await sql("grant select on public.credit_accounts to authenticated;", "postgres");
  assert.equal((await value("select count(*)::int as count from public.credit_accounts", "authenticated")).count, 0);
  await sql("revoke select on public.credit_accounts from authenticated;", "postgres");
});

test("再確認期限を過ぎた予約も実行状態の確認まで確保を維持する", async () => {
  const userId = await user();
  const reservationId = await reserve(userId, "disconnected");
  await sql(`update public.credit_reservations set review_at = now() - interval '1 minute' where id = ${literal(reservationId)};`, "postgres");
  assert.equal((await billing.balance(userId)).reserved, "60");
  assert.equal((await value(`select count(*)::int as count from public.credit_reservations where user_id = ${literal(userId)} and status = 'held' and review_at <= now()`)).count, 1);
});
