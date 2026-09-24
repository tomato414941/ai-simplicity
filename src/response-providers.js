import OpenAI from "openai";
import { AnthropicResponses } from "./anthropic-responses.js";
import { unsupported } from "./responses-format.js";

const OPTIONS = { maxRetries: 0, timeout: 600_000 };

export class NativeResponses {
  constructor(client, managed) { this.api = client.responses; this.managed = managed; }

  create(body, options) {
    if (!this.managed) {
      if (body.background === true) throw unsupported("background");
      for (const field of ["context_management", "prompt_cache_options"]) if (body[field] != null) throw unsupported(field);
      if (options.headers?.["Idempotency-Key"]) throw unsupported("Idempotency-Key");
      if (body.tools?.some((tool) => tool.type !== "function")) throw unsupported("tools");
    }
    // Persistence is ours on stateless providers. Do not ask them to retain data.
    return this.api.create(this.managed ? body : { ...body, store: false, provider: { allow_fallbacks: false, require_parameters: true } }, { ...OPTIONS, ...options }).asResponse();
  }
  retrieve(id, query, options) { return this.api.retrieve(id, query, { ...OPTIONS, ...options }).asResponse(); }
  delete(id, options) { return this.api.delete(id, { ...OPTIONS, ...options }).asResponse(); }
  cancel(id, options) { return this.api.cancel(id, { ...OPTIONS, ...options }).asResponse(); }
  compact(body, options) {
    if (!this.managed) throw unsupported("compact");
    return this.api.compact(body, { ...OPTIONS, ...options }).asResponse();
  }
  inputTokens(body, options) {
    if (!this.managed) throw unsupported("input_tokens");
    return this.api.inputTokens.count(body, { ...OPTIONS, ...options }).asResponse();
  }
}

// Server-owned allowlist, not a URL or credential supplied by an API caller.
// A public model ID maps to exactly one provider and one upstream model.
export function responseConfiguration(env, fetchImpl = globalThis.fetch) {
  const defaultModel = env.OPENAI_MODEL ?? "gpt-6-astra";
  const configured = env.RESPONSES_MODELS ? JSON.parse(env.RESPONSES_MODELS) : {
    [defaultModel]: { provider: "openai", model: defaultModel },
  };
  if (!configured || typeof configured !== "object" || Array.isArray(configured) || !Object.keys(configured).length) throw new Error("RESPONSES_MODELS must be a nonempty model map.");
  const providers = new Map(), models = new Map();
  const definitions = {
    openai: { key: "OPENAI_API_KEY", url: "https://api.openai.com/v1", managed: true },
    openrouter: { key: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1", managed: false },
    anthropic: { key: "ANTHROPIC_API_KEY" },
  };
  // Removing a model from the create allowlist must not reroute its saved responses.
  for (const [name, definition] of Object.entries(definitions)) {
    if (env[definition.key]) providers.set(name, name === "anthropic"
      ? new AnthropicResponses({ apiKey: env[definition.key], fetch: fetchImpl, workspace: env.ANTHROPIC_WORKSPACE_ID })
      : new NativeResponses(new OpenAI({ apiKey: env[definition.key], baseURL: definition.url, fetch: fetchImpl, maxRetries: 0 }), definition.managed));
  }
  for (const [id, route] of Object.entries(configured)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id) || !route || typeof route !== "object" || Array.isArray(route) ||
        Object.keys(route).some((key) => !["provider", "model"].includes(key)) || !Object.hasOwn(definitions, route.provider) ||
        typeof route.model !== "string" || !route.model || route.model.length > 200) throw new Error("Invalid Responses model configuration.");
    const definition = definitions[route.provider];
    if (!env[definition.key]) throw new Error(definition.key + " is required for a configured Responses model.");
    models.set(id, { ...route });
  }
  return { models, providers };
}
