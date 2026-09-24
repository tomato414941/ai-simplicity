import { createHash } from "node:crypto";

export function invalid(message, param) {
  return Object.assign(new Error(message), { status: 400, local: true, param });
}

export function unsupported(param) { return invalid("This provider does not support this parameter or operation.", param); }
export function upstreamFailure() { return Object.assign(new Error("Invalid response from provider."), { status: 502 }); }

// An upstream ID is meaningful only at its provider. OpenAI already supplies our
// public ID format; other providers get a stable, namespaced Responses ID.
export function responseId(provider, value) {
  if (value?.object !== "response" || typeof value.id !== "string" || !value.id || value.id.length > 256) throw upstreamFailure();
  if (provider === "openai") {
    if (!/^resp_[\w-]{1,200}$/.test(value.id)) throw upstreamFailure();
    return value.id;
  }
  return "resp_" + provider + "_" + createHash("sha256").update(value.id).digest("hex");
}

export function eventStream(events, headers) {
  const encoder = new TextEncoder();
  async function* bytes() {
    for await (const event of events) yield encoder.encode("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
  }
  return new Response(ReadableStream.from(bytes()), { headers: { "content-type": "text/event-stream", ...headers } });
}

export function responseHeaders(upstream) {
  const headers = {};
  for (const name of ["x-request-id", "retry-after", "retry-after-ms", "x-should-retry"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}
