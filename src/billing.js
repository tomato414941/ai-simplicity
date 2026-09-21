const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9]\d{0,20})(?:\.\d{1,9})?$/;
const MAX_CREDITS = 9_223_372_036_854_775_807n;
const SCALE = 1_000_000_000n;

// Price and supplier cost are deliberately separate. Round once per charge,
// to the smallest integer credit unit, not once per provider request/token.
export function priceQuantity(quantity, creditsPerUnit) {
  const product = decimal(quantity) * decimal(creditsPerUnit);
  const divisor = SCALE * SCALE;
  return credits(((product + divisor - 1n) / divisor).toString(), true);
}

export class Billing {
  constructor(client) { this.client = client; }

  balance(userId, options = {}) {
    return this.rpc("credit_balance", { p_user_id: uuid(userId) }, options);
  }

  async history(userId, { limit = 20, after } = {}, options = {}) {
    uuid(userId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Invalid limit.");
    let query = this.client.from("credit_history")
      .select("id,kind,credits,reason,pricing,refunds_id,created_at").eq("user_id", userId);
    if (after) {
      uuid(after);
      let cursorQuery = this.client.from("credit_history").select("id,created_at")
        .eq("user_id", userId).eq("id", after).maybeSingle();
      if (options.signal) cursorQuery = cursorQuery.abortSignal(options.signal);
      const { data: cursor, error } = await cursorQuery;
      if (error) throw databaseError(error);
      if (!cursor) throw invalid("Unknown cursor.");
      // Both values come from our DB (UUID + timestamptz), not raw query syntax.
      query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
    }
    query = query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (options.signal) query = query.abortSignal(options.signal);
    const { data, error } = await query;
    if (error) throw databaseError(error);
    return { data: data.slice(0, limit), has_more: data.length > limit,
      next: data.length > limit ? data[limit - 1].id : null };
  }

  recordUsage(record) {
    observation(record, ["metric", "unit", "quantity"]);
    label(record.metric, 100);
    label(record.unit, 100);
    if (!["unknown", "provisional", "final"].includes(record.status)) throw invalid("Invalid usage status.");
    if (record.status === "unknown") {
      if (record.quantity !== null) throw invalid("Unknown usage must have a null quantity.");
    } else decimal(record.quantity);
    return this.rpc("billing_record_usage", { p_record: record });
  }

  recordCost(record) {
    observation(record, ["attribution", "amount", "currency", "usage_id"]);
    if (!["user", "shared", "unassigned"].includes(record.attribution) ||
        (record.attribution === "user") !== Boolean(record.user_id)) throw invalid("Invalid cost attribution.");
    if (typeof record.currency !== "string" || !/^[A-Z]{3}$/.test(record.currency)) throw invalid("Invalid currency.");
    if (!["unknown", "estimated", "final"].includes(record.status)) throw invalid("Invalid cost status.");
    if (record.status === "unknown") {
      if (record.amount !== null) throw invalid("Unknown cost must have a null amount.");
    } else decimal(record.amount, true);
    if (record.usage_id != null) uuid(record.usage_id);
    return this.rpc("billing_record_cost", { p_record: record });
  }

  grant({ userId, source, reference, amount, reason }) {
    return this.rpc("credit_grant", { p_user_id: uuid(userId), p_source: label(source, 100),
      p_reference: label(reference, 512), p_credits: credits(amount), p_reason: label(reason, 200) });
  }

  reserve({ userId, reference, amount, pricing, reviewAt }) {
    if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) throw invalid("Pricing is required.");
    label(pricing.version, 100);
    timestamp(reviewAt);
    return this.rpc("credit_reserve", { p_user_id: uuid(userId), p_reference: label(reference, 512),
      p_credits: credits(amount), p_pricing: pricing, p_review_at: reviewAt });
  }

  settle({ userId, reservationId, amount }) {
    return this.rpc("credit_settle", { p_user_id: uuid(userId), p_reservation_id: uuid(reservationId), p_credits: credits(amount, true) });
  }

  release({ userId, reservationId, reason }) {
    return this.rpc("credit_release", { p_user_id: uuid(userId), p_reservation_id: uuid(reservationId), p_reason: label(reason, 200) });
  }

  refund({ userId, chargeId, reason }) {
    return this.rpc("credit_refund", { p_user_id: uuid(userId), p_charge_id: uuid(chargeId), p_reason: label(reason, 200) });
  }

  async rpc(name, parameters, options = {}) {
    let query = this.client.rpc(name, parameters);
    if (options.signal) query = query.abortSignal(options.signal);
    const { data, error } = await query;
    if (error) throw databaseError(error);
    return data;
  }
}

function observation(value, fields) {
  const allowed = ["source", "reference", "user_id", "status", "occurred_at", "period_end", "supersedes_id", ...fields];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw invalid("Invalid accounting record.");
  }
  label(value.source, 100);
  label(value.reference, 512);
  if (value.user_id != null) uuid(value.user_id);
  if (value.supersedes_id != null) uuid(value.supersedes_id);
  timestamp(value.occurred_at);
  if (value.period_end != null) {
    timestamp(value.period_end);
    if (Date.parse(value.period_end) < Date.parse(value.occurred_at)) throw invalid("Invalid accounting period.");
  }
}

function decimal(value, signed = false) {
  const negative = signed && typeof value === "string" && value.startsWith("-");
  const magnitude = negative ? value.slice(1) : value;
  if (typeof magnitude !== "string" || !DECIMAL.test(magnitude)) throw invalid("Use a decimal string with at most nine decimal places and an allowed sign.");
  const [integer, fraction = ""] = magnitude.split(".");
  return (BigInt(integer) * SCALE + BigInt(fraction.padEnd(9, "0"))) * (negative ? -1n : 1n);
}

function credits(value, zero = false) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > MAX_CREDITS || (!zero && value === "0")) {
    throw invalid("Credits must be an integer string in range.");
  }
  return value;
}

function label(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid("Invalid accounting identifier or reason.");
  return value;
}
function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid("Invalid identifier.");
  return value;
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalid("Use a timestamp with a time zone.");
  }
}
function invalid(message) { return Object.assign(new Error(message), { status: 400, local: true, code: "invalid_billing_request" }); }
function databaseError(error) {
  if (error.code === "P0001" && error.message === "insufficient_credits") {
    return Object.assign(new Error("The available credit balance is insufficient."), { status: 402, local: true, code: "insufficient_credits" });
  }
  if (error.code === "P0002") return Object.assign(new Error("Not found."), { status: 404, local: true, code: "not_found" });
  if (["P0001", "23505"].includes(error.code)) {
    return Object.assign(new Error("The accounting operation conflicts with an existing record."), { status: 409, local: true, code: "billing_conflict" });
  }
  if (["22023", "23514", "23502", "23503", "22003", "22007", "22008", "22P02"].includes(error.code)) return invalid("Invalid accounting data.");
  return Object.assign(new Error("Billing storage is unavailable."), { status: 503, code: "billing_unavailable" });
}
