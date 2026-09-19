import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_REDIRECT, INVALID_LINK, callbackCode, emailError } from "../src/auth-flow.ts";

test("only our exact callback is accepted; no credentials from unrelated deep links", () => {
  assert.equal(callbackCode(`${AUTH_REDIRECT}?code=code-1`), "code-1");
  for (const url of ["https://example.com/?code=x", "aisimplicity://elsewhere/callback?code=x", "aisimplicity://auth/callback/other?code=x", "invalid"]) {
    assert.equal(callbackCode(url), null);
  }
});
test("expired, consumed and incomplete links show a safe explanation, not provider details", () => {
  for (const suffix of ["#error=access_denied&error_description=secret", "?error=otp_expired", "#access_token=secret", ""]) {
    assert.throws(() => callbackCode(AUTH_REDIRECT + suffix), { message: INVALID_LINK });
  }
});
test("mail throttling is distinct from an invalid email", () => {
  assert.match(emailError({ code: "over_email_send_rate_limit" }), /送信上限/);
  assert.match(emailError({ code: "email_exists" }), /登録済み/);
  assert.doesNotMatch(emailError(new Error("provider secret")), /provider secret/);
});
