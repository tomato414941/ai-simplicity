export function mountAccount({ auth, getUser, hasConversation, signOut, request }) {
  const dialog = document.querySelector("#account-dialog");
  const open = document.querySelector("#account-open");
  const close = document.querySelector("#account-close");
  const title = document.querySelector("#account-title");
  const description = document.querySelector("#account-description");
  const form = document.querySelector("#account-form");
  const email = document.querySelector("#account-email");
  const send = document.querySelector("#account-send");
  const toggle = document.querySelector("#account-toggle");
  const logout = document.querySelector("#account-logout");
  const status = document.querySelector("#account-status");
  const usage = Object.fromEntries(["body", "refresh", "status", "notice", "available", "balance", "reserved", "hold-note", "entries", "empty", "more", "page-status"]
    .map((name) => [name, document.querySelector(`#account-usage-${name}`)]));
  const usageSection = document.querySelector("#account-usage");
  const number = new Intl.NumberFormat("ja-JP");
  const date = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  let mode = "register", busy = false;
  let usageOwner, usageRequest = null, after = null;

  open.disabled = false;
  open.addEventListener("click", () => {
    mode = getUser() ? "register" : "login"; status.textContent = ""; render(); dialog.showModal();
    void loadUsage();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", clearUsage);
  usage.refresh.addEventListener("click", () => { void loadUsage(); });
  usage.more.addEventListener("click", () => { if (after && !usageRequest) void loadUsage(true); });
  toggle.addEventListener("click", () => { mode = mode === "register" ? "login" : "register"; status.textContent = ""; render(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const user = getUser();
    // Signing into a different account cannot silently replace an anonymous
    // conversation. Linking an email keeps the existing Supabase user ID.
    if (mode === "login" && user?.is_anonymous && hasConversation()) {
      status.textContent = "この会話を残すには、先にメールアドレスを登録してください。";
      return;
    }
    busy = true; status.textContent = "メールを送っています"; render();
    try {
      const address = email.value.trim();
      const redirect = window.location.origin + "/";
      const result = mode === "register" && user?.is_anonymous
        ? await auth.updateUser({ email: address }, { emailRedirectTo: redirect })
        : await auth.signInWithOtp({ email: address, options: { shouldCreateUser: false, emailRedirectTo: redirect } });
      if (result.error) throw result.error;
      status.textContent = "メールのリンクを開いてください。届かない場合は迷惑メールもご確認ください。";
    } catch (error) {
      status.textContent = error.code === "email_exists" || error.code === "email_address_not_authorized"
        ? "このメールアドレスは登録に使えません。別のアドレスをお試しください。"
        : "メールを送れませんでした。アドレスを確認し、少し待ってからお試しください。";
    } finally { busy = false; render(); }
  });
  logout.addEventListener("click", async () => {
    if (busy) return;
    busy = true; render();
    try { await signOut(); dialog.close(); }
    catch { status.textContent = "ログアウトできませんでした。もう一度お試しください。"; }
    finally { busy = false; render(); }
  });

  function clearUsage() {
    usageRequest?.abort(); usageRequest = null; after = null;
    usage.body.hidden = true;
    usage.entries.replaceChildren();
    for (const name of ["available", "balance", "reserved"]) usage[name].textContent = "—";
    usage.status.textContent = ""; usage["page-status"].textContent = "";
    usage.refresh.disabled = false; usage.more.hidden = true;
  }

  async function loadUsage(more = false) {
    const userId = getUser()?.id;
    if (!userId || !dialog.open) return;
    if (!more) clearUsage();
    const controller = new AbortController();
    usageRequest = controller;
    const current = () => usageRequest === controller && !controller.signal.aborted && getUser()?.id === userId && dialog.open;
    const message = more ? usage["page-status"] : usage.status;
    message.textContent = "読み込んでいます…";
    usage.refresh.disabled = true; usage.more.disabled = true;
    try {
      const query = new URLSearchParams({ limit: "20", ...(more ? { after } : {}) });
      const [balance, history] = await Promise.all([
        more ? null : request("/api/billing", controller.signal),
        request(`/api/billing/entries?${query}`, controller.signal),
      ]);
      if (!current()) return;
      const rows = history.data.map((entry) => {
        const row = document.createElement("li");
        const description = document.createElement("div");
        const label = document.createElement("span");
        label.textContent = { grant: "クレジット追加", charge: "利用", refund: "クレジット返還" }[entry.kind];
        const time = document.createElement("time");
        time.dateTime = entry.created_at;
        time.textContent = date.format(new Date(entry.created_at));
        const amount = document.createElement("span");
        const credits = BigInt(entry.credits);
        amount.className = `credit-entry-amount${credits > 0n ? " is-credit" : ""}`;
        amount.textContent = `${credits > 0n ? "+" : ""}${number.format(credits)}`;
        amount.setAttribute("aria-label", `${amount.textContent}クレジット`);
        description.append(label, time); row.append(description, amount);
        return row;
      });
      if (balance) {
        usage.available.textContent = number.format(BigInt(balance.available));
        usage.balance.textContent = number.format(BigInt(balance.balance));
        usage.reserved.textContent = number.format(BigInt(balance.reserved));
        usage.notice.hidden = balance.pricing_status !== "unconfigured";
        usage["hold-note"].hidden = BigInt(balance.reserved) === 0n;
      }
      usage.entries.append(...rows);
      after = history.has_more ? history.next : null;
      usage.more.hidden = !after;
      usage.empty.hidden = usage.entries.children.length !== 0;
      usage.body.hidden = false;
      message.textContent = "";
    } catch {
      if (current()) message.textContent = more
        ? "続きを読み込めませんでした。もう一度お試しください。"
        : "利用状況を読み込めませんでした。もう一度お試しください。";
    } finally {
      if (current()) {
        usageRequest = null;
        usage.refresh.disabled = false; usage.more.disabled = false;
      }
    }
  }

  function render() {
    const user = getUser();
    const registered = Boolean(user && !user.is_anonymous);
    const login = mode === "login" || !user;
    title.textContent = registered ? "登録情報" : login ? "会話の続きを開く" : "この会話を引き継ぐ";
    description.textContent = registered ? `${user.email}\n別の端末でも、このメールアドレスで会話を続けられます。`
      : login ? "登録済みのメールアドレスに、ログイン用のリンクを送ります。"
      : "メールアドレスを登録すると、別の端末でもこの会話を続けられます。登録するまでは、このブラウザのデータを消さないでください。";
    form.hidden = registered;
    logout.hidden = !registered;
    toggle.hidden = registered || !user || (user.is_anonymous && hasConversation());
    toggle.textContent = login ? "この会話を引き継ぐ" : "登録済みのメールでログイン";
    send.textContent = busy ? "送信中" : "メールを送る";
    for (const control of [send, toggle, logout, email]) control.disabled = busy;
    usageSection.hidden = !user;
    if (usageOwner !== user?.id) {
      usageOwner = user?.id;
      clearUsage();
      if (dialog.open) void loadUsage();
    }
  }
  render();
  return { render };
}
