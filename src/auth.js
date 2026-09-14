const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function unauthorized() {
  return Object.assign(new Error("A valid access token is required."), {
    status: 401, type: "authentication_error", code: "invalid_api_key", local: true,
  });
}

// Supabase verifies the signature and expiry, using its cached public signing keys.
// Never use decoded JWTs, user_metadata or a caller-supplied user_id as identity.
export function createAuthenticator({ auth, url }) {
  const issuer = `${url.replace(/\/$/, "")}/auth/v1`;
  return async (request) => {
    const token = request.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token || token.length > 16_384) throw unauthorized();
    let result;
    try { result = await auth.getClaims(token); }
    catch { throw Object.assign(new Error("Authentication is unavailable."), { status: 503 }); }
    if (result.error) {
      if (result.error.status >= 500 || result.error.name === "AuthRetryableFetchError") {
        throw Object.assign(new Error("Authentication is unavailable."), { status: 503 });
      }
      throw unauthorized();
    }
    const claims = result.data?.claims;
    if (!claims || !UUID.test(claims.sub) || claims.iss !== issuer || claims.aud !== "authenticated" ||
        claims.role !== "authenticated" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > Date.now()))) {
      throw unauthorized();
    }
    return { id: claims.sub, expiresAt: claims.exp * 1000 };
  };
}
