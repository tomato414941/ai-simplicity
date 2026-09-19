export const AUTH_REDIRECT = "aisimplicity://auth/callback";
export const INVALID_LINK = "このリンクは使えません。新しいメールを送り、この端末で最新のリンクを開いてください。";

export function callbackCode(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "aisimplicity:" || url.hostname !== "auth" || url.pathname !== "/callback") return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (url.searchParams.has("error") || fragment.has("error")) throw new Error(INVALID_LINK);
  const code = url.searchParams.get("code");
  if (!code) throw new Error(INVALID_LINK);
  return code;
}

export function emailError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (["over_email_send_rate_limit", "over_request_rate_limit"].includes(code ?? "")) return "メールの送信上限に達しました。しばらく待ってからお試しください。";
  if (code === "email_exists") return "登録済みのメールアドレスです。ログインからお試しください。";
  if (code === "email_address_not_authorized") return "このメールアドレスには、まだメールを送れません。";
  return "メールを送れませんでした。アドレスを確認し、少し待ってからお試しください。";
}
