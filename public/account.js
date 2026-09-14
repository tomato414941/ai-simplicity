export function mountAccount({ auth, getUser, hasConversation, signOut }) {
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
  let mode = "register", busy = false;

  open.disabled = false;
  open.addEventListener("click", () => { mode = getUser() ? "register" : "login"; status.textContent = ""; render(); dialog.showModal(); });
  close.addEventListener("click", () => dialog.close());
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

  function render() {
    const user = getUser();
    const registered = Boolean(user && !user.is_anonymous);
    const login = mode === "login" || !user;
    title.textContent = registered ? "アカウント" : login ? "会話の続きを開く" : "この会話を引き継ぐ";
    description.textContent = registered ? `${user.email}\n別の端末でも、このメールアドレスで会話を続けられます。`
      : login ? "登録済みのメールアドレスに、ログイン用のリンクを送ります。"
      : "メールアドレスを登録すると、別の端末でもこの会話を続けられます。登録するまでは、このブラウザのデータを消さないでください。";
    form.hidden = registered;
    logout.hidden = !registered;
    toggle.hidden = registered || !user || (user.is_anonymous && hasConversation());
    toggle.textContent = login ? "この会話を引き継ぐ" : "登録済みのメールでログイン";
    send.textContent = busy ? "送信中" : "メールを送る";
    for (const control of [send, toggle, logout, email]) control.disabled = busy;
  }
  render();
  return { render };
}
