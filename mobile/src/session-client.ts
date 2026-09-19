import { SessionState, isTerminal, itemText, readEvents } from "../../shared/agent-session.js";
import type { AgentSession, AgentSessionEvent, AgentSessionItem, AgentSessionInputParam, AgentSessionMessage } from "openai/resources/beta/agents/agents";
import type { SessionCreateParamsNonStreaming } from "openai/resources/beta/agents/sessions/sessions";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";

type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
type Pending = { session_id: string; idempotency_key: string; events: AgentSessionInputParam[]; acknowledged: boolean };
type Connection = { controller: AbortController; ready: boolean; buffer: AgentSessionEvent[]; syncing?: Promise<void> };
type Page<T> = { data: T[]; has_more: boolean; last_id: string | null };
export type Message = { id: string; role: "user" | "assistant"; text: string; ending: string };
export type View = {
  messages: Message[]; draft: string; status: string; action: string;
  generating: boolean; stopping: boolean; canSend: boolean; canStop: boolean; canEdit: boolean; hasConversation: boolean;
};

const ROOT = "/v1/agents/sessions";
const REQUEST_MS = 10_000;
const RECOVERY_MS = 60_000;

// One authenticated client's view. No new server resources or event vocabulary.
export class SessionClient {
  private state = new SessionState();
  private connection: Connection | null = null;
  private lifetime = new AbortController();
  private listeners = new Set<() => void>();
  private connected = false;
  private foreground = true;
  private loaded = false;
  private operation = false;
  private draft = "";
  private pending: Pending | null = null;
  private stopping: string | null = null;
  private stopErrorTurnId: string | null = null;
  private notice = "";
  private unavailableSince: number | null = null;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  private view: View;
  private options: {
    origin: string; userId: string; token: string; defaults: SessionCreateParamsNonStreaming;
    fetch: typeof fetch; storage: Storage; uuid(): string;
  };

  constructor(options: SessionClient["options"]) { this.options = options; this.view = this.makeView(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.view;
  private publish() { if (!this.lifetime.signal.aborted) { this.view = this.makeView(); this.listeners.forEach((listener) => listener()); } }
  private get key() { return `ai-simplicity.${this.options.userId}.input`; }
  private get activeTurn() { const turn = this.state.latestTurn; return turn && !isTerminal(turn) ? turn : null; }
  private get base() { return `${ROOT}/${this.state.session!.id}`; }
  private remaining() { return this.unavailableSince === null ? Infinity : Math.max(0, RECOVERY_MS - (Date.now() - this.unavailableSince)); }

  async start() {
    try {
      const saved = await this.options.storage.getItem(this.key);
      if (this.lifetime.signal.aborted) return;
      if (saved) {
        const value = JSON.parse(saved);
        if (typeof value.draft !== "string" || (value.pending &&
          (typeof value.pending.idempotency_key !== "string" || !Array.isArray(value.pending.events)))) throw new Error("Invalid saved input");
        this.draft = value.draft;
        this.pending = value.pending?.acknowledged ? null : value.pending;
      }
      this.loaded = true;
      await this.connect();
    } catch {
      this.notice = "保存した入力を読み込めませんでした。もう一度お試しください。";
      this.publish();
    }
  }

  dispose() { this.lifetime.abort(); this.pause(); this.listeners.clear(); }
  pause() {
    this.foreground = false;
    clearTimeout(this.timer);
    const previous = this.connection;
    this.connection = null;
    previous?.controller.abort();
    this.connected = false;
    this.publish();
  }
  resume() {
    this.foreground = true;
    this.unavailableSince = null;
    this.attempt = 0;
    if (this.loaded) void this.connect();
  }
  setToken(token: string) {
    if (this.options.token === token) return;
    this.options.token = token;
    if (this.foreground && this.loaded) void this.connect();
  }
  setDraft(text: string) {
    if (!this.loaded || this.operation) return;
    this.draft = text;
    this.publish();
    void this.persist().catch(() => { this.notice = "入力をこの端末に保存できません。"; this.publish(); });
  }
  private persist() {
    const value = JSON.stringify({ draft: this.draft, pending: this.pending });
    this.writes = this.writes.catch(() => {}).then(() => this.options.storage.setItem(this.key, value));
    return this.writes;
  }

  private async request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const signals = [this.lifetime.signal, ...(signal ? [signal] : [])];
    const abort = () => controller.abort();
    signals.forEach((parent) => parent.aborted ? abort() : parent.addEventListener("abort", abort));
    const timer = setTimeout(abort, Math.max(1, Math.min(REQUEST_MS, signal ? this.remaining() : Infinity)));
    try {
      const response = await this.options.fetch(this.options.origin + path, {
        ...options, signal: controller.signal,
        headers: { "Content-Type": "application/json", "OpenAI-Beta": "agents=v1", ...options.headers, Authorization: `Bearer ${this.options.token}` },
      });
      if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status });
      return (response.status === 204 ? null : await response.json()) as T;
    } finally {
      clearTimeout(timer);
      signals.forEach((parent) => parent.removeEventListener("abort", abort));
    }
  }
  private async allPages<T>(path: string, signal: AbortSignal): Promise<T[]> {
    const data: T[] = [];
    let after: string | null = null;
    while (true) {
      const query = new URLSearchParams({ order: "asc", limit: "100", ...(after ? { after } : {}) });
      const page: Page<T> = await this.request(`${path}?${query}`, {}, signal);
      data.push(...page.data);
      if (!page.has_more) return data;
      if (!page.last_id || page.last_id === after) throw new Error("Invalid cursor");
      after = page.last_id;
    }
  }

  private async connect() {
    if (!this.foreground || this.lifetime.signal.aborted) return;
    clearTimeout(this.timer);
    const previous = this.connection;
    const current: Connection = { controller: new AbortController(), ready: false, buffer: [] };
    this.connection = current;
    previous?.controller.abort();
    this.connected = false;
    this.publish();
    try {
      if (!this.state.session) {
        const page = await this.request<Page<AgentSession>>(`${ROOT}?limit=1`, {}, current.controller.signal);
        if (this.connection !== current) return;
        this.state.session = page.data[0] ?? null;
      }
      if (this.state.session) {
        // Only response headers have a deadline, never the model's thinking time.
        const opening = setTimeout(() => current.controller.abort(), Math.min(REQUEST_MS, this.remaining()));
        let response: Response;
        try {
          response = await this.options.fetch(`${this.options.origin}${this.base}/events`, {
            headers: { Accept: "text/event-stream", "OpenAI-Beta": "agents=v1", Authorization: `Bearer ${this.options.token}` },
            signal: current.controller.signal,
          });
        } finally { clearTimeout(opening); }
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Stream unavailable");
        void this.consume(current, response.body);
        await this.synchronize(current);
      }
      if (this.connection !== current || current.controller.signal.aborted) return;
      this.connected = true;
      this.unavailableSince = null;
      this.attempt = 0;
      this.publish();
    } catch { this.recover(current); }
  }
  private async consume(current: Connection, body: ReadableStream<Uint8Array>) {
    try {
      for await (const event of readEvents(body)) {
        if (this.connection !== current || current.controller.signal.aborted) return;
        if (!current.ready) current.buffer.push(event);
        else this.apply(event, current);
      }
    } catch { /* Recover on stream error as well as unexpected EOF. */ }
    this.recover(current);
  }
  private async synchronize(current: Connection) {
    if (current.syncing) return current.syncing;
    current.ready = false;
    current.syncing = (async () => {
      const signal = current.controller.signal;
      const [session, items, turns] = await Promise.all([
        this.request<AgentSession>(this.base, {}, signal),
        this.allPages<AgentSessionItem>(`${this.base}/items`, signal),
        this.allPages<Turn>(`${this.base}/turns`, signal),
      ]);
      if (this.connection !== current || signal.aborted) return;
      this.state.restore(session, items, turns);
      current.ready = true;
      for (const event of current.buffer.splice(0)) this.apply(event, current, true);
      this.settleStop();
      this.publish();
    })();
    try { await current.syncing; } finally { current.syncing = undefined; }
  }
  private apply(event: AgentSessionEvent, current: Connection, restoring = false) {
    if (event.type === "error") throw new Error("Stream error");
    this.state.apply(event);
    if (event.type === "agent.session.environment.failed") this.notice = "今は返答を続けられません。";
    this.settleStop();
    this.publish();
    if (!restoring && (("turn" in event && event.turn.subagent_id == null && isTerminal(event.turn)) ||
      ["agent.session.failed", "agent.session.environment.failed", "agent.session.requires_action"].includes(event.type))) {
      void this.synchronize(current).catch(() => this.recover(current));
    }
  }
  private recover(current: Connection | null) {
    if (this.connection !== current || !this.foreground || this.lifetime.signal.aborted) return;
    this.connection = null;
    current?.controller.abort();
    this.connected = false;
    this.unavailableSince ??= Date.now();
    clearTimeout(this.timer);
    const remaining = this.remaining();
    if (remaining > 0) this.timer = setTimeout(() => {
      if (this.remaining() > 0) void this.connect(); else this.publish();
    }, Math.min(1_000 * 2 ** this.attempt++, 8_000, remaining));
    this.publish();
  }

  async send() {
    if (!this.view.canSend) return;
    this.operation = true;
    this.notice = "";
    this.publish();
    try {
      await this.persist();
    } catch {
      this.notice = "この端末に入力を保存できないため、送信していません。";
      this.operation = false; this.publish(); return;
    }
    try {
      if (!this.state.session) {
        this.state.session = await this.request<AgentSession>(ROOT, { method: "POST", body: JSON.stringify(this.options.defaults) });
        await this.connect();
        if (!this.connected) throw new Error("Session not ready");
      }
      if (this.lifetime.signal.aborted) return;
      this.pending = {
        session_id: this.state.session.id, idempotency_key: this.options.uuid(), acknowledged: false,
        events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: this.draft.trim() }] }] }],
      };
      const draft = this.draft;
      this.draft = "";
      try { await this.persist(); }
      catch { this.pending = null; this.draft = draft; throw new Error("Input not saved"); }
      await this.submit();
    } catch {
      this.notice = "今は送信できません。入力は残してあります。";
      // Read after uncertain creation. Never automatically repeat a write.
      void this.connect();
    } finally { this.operation = false; this.publish(); }
  }
  private async submit() {
    const pending = this.pending;
    if (!pending || pending.acknowledged || pending.session_id !== this.state.session?.id) return;
    this.operation = true; this.notice = ""; this.publish();
    try {
      await this.request(`${this.base}/events`, {
        method: "POST", headers: { "Idempotency-Key": pending.idempotency_key }, body: JSON.stringify({ events: pending.events }),
      });
      pending.acknowledged = true;
      await this.persist();
      this.pending = null;
      await this.persist();
      const current = this.connection;
      if (current) await this.synchronize(current).catch(() => this.recover(current));
    } catch (error) {
      if (pending.acknowledged) {
        this.notice = "送信済みですが、この端末への保存を確認できません。";
      } else if ([400, 401, 403, 404, 413, 415, 422, 429].includes((error as { status?: number }).status ?? 0)) {
        const event = pending.events[0];
        const text = event.type === "agent.session.input.message" ? itemText(event.input[0]) : "";
        this.draft = [text, this.draft].filter(Boolean).join("\n\n");
        this.pending = null;
        await this.persist().catch(() => {});
        this.notice = "送れませんでした。入力を残してあります。";
      } else this.recover(this.connection);
    } finally { this.operation = false; this.publish(); }
  }
  async stop() {
    if (!this.view.canStop) return;
    const turnId = this.activeTurn!.id;
    this.stopping = turnId;
    this.stopErrorTurnId = null;
    this.operation = true; this.notice = ""; this.publish();
    try {
      await this.request(`${this.base}/events`, { method: "POST", body: JSON.stringify({ events: [{ type: "agent.session.input.cancel" }] }) });
      // An acknowledgment is not proof of cancellation; wait for the native turn.
      if (!this.connected) { this.unavailableSince = null; void this.connect(); }
    } catch {
      this.stopping = null;
      this.stopErrorTurnId = turnId;
      this.recover(this.connection);
    } finally { this.operation = false; this.settleStop(); this.publish(); }
  }
  private settleStop() { if (this.stopping && isTerminal(this.state.turns.get(this.stopping))) this.stopping = null; }
  async retry() {
    if (this.operation) return;
    this.notice = "";
    if (!this.loaded) return this.start();
    if (this.connected && this.pending && !this.pending.acknowledged) return this.submit();
    if (this.view.action === "再試行") {
      const input = [...this.state.items.values()].find((item) => item.type === "message" && item.role === "user" && item.turn_id === this.state.latestTurn?.id);
      if (input?.type === "message") { this.setDraft(itemText(input)); return this.send(); }
    }
    this.unavailableSince = null; this.attempt = 0;
    await this.connect();
  }

  private makeView(): View {
    const messages: Message[] = [];
    const ending = (turn?: Turn) => turn?.status === "cancelled" ? "停止しました" : turn?.status === "failed" ? "返答を作れませんでした" : "";
    for (const [id, item] of this.state.items) if (item.type === "message" && item.phase !== "commentary") {
      messages.push({ id, role: item.role, text: itemText(item), ending: item.role === "assistant" ? ending(this.state.turns.get(item.turn_id)) : "" });
    }
    for (const turn of this.state.turns.values()) {
      if (turn.subagent_id != null || !ending(turn)) continue;
      const entries = [...this.state.items].filter(([, item]) => item.type === "message" && item.phase !== "commentary" && item.turn_id === turn.id);
      if (entries.some(([, item]) => (item as AgentSessionMessage).role === "assistant")) continue;
      const index = messages.findIndex((message) => message.id === entries.at(-1)?.[0]);
      messages.splice(index < 0 ? messages.length : index + 1, 0, { id: `ending:${turn.id}`, role: "assistant", text: "", ending: ending(turn) });
    }
    const generating = Boolean(this.activeTurn);
    const stopError = this.activeTurn?.id === this.stopErrorTurnId ? "停止を確認できませんでした。もう一度お試しください。" : "";
    let status = this.notice || stopError, action = "";
    if (!this.loaded && this.notice) action = "もう一度確認";
    else if (!this.connected) {
      status = this.stopping ? "停止の状態を確認しています" : this.pending ? "送信の状態を確認しています" : "会話を読み込んでいます";
      if (this.remaining() === 0) { status = "今は接続できません。入力はこの端末に残っています。"; action = "もう一度確認"; }
    } else if (this.operation) status = this.stopping ? "停止しています" : "送信しています";
    else if (this.pending && !this.pending.acknowledged) { status = "送信を確認できませんでした。入力は保存されています。"; action = "もう一度送信"; }
    else if (this.state.session?.status === "failed") { status = "今は会話を続けられません。"; action = "もう一度確認"; }
    else if (this.state.session?.status === "requires_action") { status = "返答が一時停止しています。"; action = "もう一度確認"; }
    else if (generating) status = this.stopping ? "停止しています" : this.notice || stopError || (this.activeTurn?.status === "waiting" ? "返答が一時停止しています。" : "返答を待っています");
    else if (this.state.latestTurn?.status === "failed" && !this.notice) {
      status = "返答を作れませんでした。";
      if (!this.draft.trim() && [...this.state.items.values()].some((item) => item.type === "message" && item.role === "user" && item.turn_id === this.state.latestTurn?.id)) action = "再試行";
    }
    return { messages, draft: this.draft, status, action: this.operation ? "" : action, generating, stopping: Boolean(this.stopping),
      canSend: this.loaded && this.connected && !this.operation && !this.pending && !generating && Boolean(this.draft.trim()) && this.state.session?.status !== "failed",
      canStop: generating && !this.operation && !this.stopping, canEdit: this.loaded && !this.operation,
      hasConversation: Boolean(this.state.session || this.pending || this.draft.trim()),
    };
  }
}
