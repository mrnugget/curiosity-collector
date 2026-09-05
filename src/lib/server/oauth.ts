import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  type JsonWebKeyInput,
  verify as verifySignature,
} from "node:crypto";

export const OAUTH_SCOPES =
  "openid profile email offline_access";

export interface OAuthConfig {
  issuer: string;
  authorizationURL: string;
  tokenURL: string;
  jwksURL: string;
  resourceURL: string;
  clientID: string;
  clientSecret: string;
  redirectURI: string;
}

export interface OAuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface OAuthAuthorizationResult {
  tokens: OAuthTokens;
  identity: OAuthIdentity;
}

export interface OAuthIdentity {
  sub: string;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  token_type?: unknown;
  error?: unknown;
}

interface RequestedTokens {
  tokens: OAuthTokens;
  idToken: string | null;
}

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export function normalizeReturnTo(value: string | null, fallback: string): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  const base = new URL("https://jelly.invalid");
  const target = new URL(value, base);
  return target.origin === base.origin
    ? `${target.pathname}${target.search}${target.hash}`
    : fallback;
}

export function createOAuthTransaction(
  returnTo: string,
  now = Date.now(),
): OAuthTransaction {
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    codeVerifier: randomBytes(32).toString("base64url"),
    returnTo,
    expiresAt: now + TRANSACTION_TTL_MS,
  };
}

export function buildAuthorizationURL(
  config: OAuthConfig,
  transaction: OAuthTransaction,
): string {
  const url = new URL(config.authorizationURL);
  url.search = new URLSearchParams({
    client_id: config.clientID,
    code_challenge: createHash("sha256")
      .update(transaction.codeVerifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    nonce: transaction.nonce,
    redirect_uri: config.redirectURI,
    resource: config.resourceURL,
    response_type: "code",
    scope: OAUTH_SCOPES,
    state: transaction.state,
  }).toString();
  return url.toString();
}

export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  expectedNonce: string,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<OAuthAuthorizationResult> {
  const result = await requestTokens(
    config,
    new URLSearchParams({
      client_id: config.clientID,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: config.redirectURI,
      resource: config.resourceURL,
    }),
    fetchFn,
    now,
  );
  if (!result.idToken) {
    throw new Error("Amp token endpoint did not return an ID token");
  }
  const identity = await verifyIDToken(
    config,
    result.idToken,
    expectedNonce,
    fetchFn,
    now,
  );
  return { tokens: result.tokens, identity };
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<OAuthTokens> {
  const result = await requestTokens(
    config,
    new URLSearchParams({
      client_id: config.clientID,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: config.resourceURL,
    }),
    fetchFn,
    now,
  );
  return result.tokens;
}

async function requestTokens(
  config: OAuthConfig,
  body: URLSearchParams,
  fetchFn: typeof fetch,
  now: number,
): Promise<RequestedTokens> {
  const response = await fetchFn(config.tokenURL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = (await response.json().catch(() => null)) as TokenResponse | null;
  if (!response.ok) {
    const providerError =
      typeof payload?.error === "string" ? ` (${payload.error})` : "";
    throw new Error(`Amp token exchange failed with HTTP ${response.status}${providerError}`);
  }
  if (
    typeof payload?.access_token !== "string" ||
    (payload.token_type !== undefined &&
      (typeof payload.token_type !== "string" ||
        payload.token_type.toLowerCase() !== "bearer"))
  ) {
    throw new Error("Amp token endpoint returned an invalid response");
  }
  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in) &&
    payload.expires_in > 0
      ? payload.expires_in
      : null;
  return {
    tokens: {
      accessToken: payload.access_token,
      refreshToken:
        typeof payload.refresh_token === "string" ? payload.refresh_token : null,
      expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
    },
    idToken: typeof payload.id_token === "string" ? payload.id_token : null,
  };
}

async function verifyIDToken(
  config: OAuthConfig,
  idToken: string,
  expectedNonce: string,
  fetchFn: typeof fetch,
  now: number,
): Promise<OAuthIdentity> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("Amp returned a malformed ID token");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJWTPart(encodedHeader);
  const claims = decodeJWTPart(encodedPayload);
  if (
    !isRecord(header) ||
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !isRecord(claims)
  ) {
    throw new Error("Amp returned an invalid ID token header");
  }

  const jwksResponse = await fetchFn(config.jwksURL, {
    headers: { Accept: "application/json" },
  });
  const jwks = (await jwksResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const jwk = keys.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.kid === header.kid &&
      candidate.kty === "RSA" &&
      (candidate.use === undefined || candidate.use === "sig") &&
      (candidate.alg === undefined || candidate.alg === "RS256") &&
      typeof candidate.n === "string" &&
      typeof candidate.e === "string",
  );
  if (!jwksResponse.ok || !isRecord(jwk)) {
    throw new Error("Amp ID token signing key is unavailable");
  }

  let signatureValid = false;
  try {
    const publicKey = createPublicKey({
      key: jwk as JsonWebKeyInput['key'],
      format: "jwk",
    });
    signatureValid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
      publicKey,
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch {
    // Treat malformed signing keys and signatures alike as invalid tokens.
  }
  if (!signatureValid) {
    throw new Error("Amp ID token signature is invalid");
  }

  const audiences =
    typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud) && claims.aud.every((value) => typeof value === "string")
        ? claims.aud
        : [];
  const nowSeconds = Math.floor(now / 1000);
  if (
    claims.iss !== config.issuer ||
    !audiences.includes(config.clientID) ||
    (audiences.length > 1 && claims.azp !== config.clientID) ||
    (claims.azp !== undefined && claims.azp !== config.clientID) ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds ||
    (claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" || claims.nbf > nowSeconds + 60)) ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.nonce !== expectedNonce
  ) {
    throw new Error("Amp ID token claims are invalid");
  }
  const optionalString = (key: string): string | null =>
    typeof claims[key] === "string" ? claims[key] : null;
  return {
    sub: claims.sub,
    name: optionalString("name"),
    givenName: optionalString("given_name"),
    familyName: optionalString("family_name"),
    email: optionalString("email"),
  };
}

function decodeJWTPart(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid JWT encoding");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Invalid JWT encoding");
  }
  try {
    return JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid JWT JSON");
  }
}

/** Encrypt and authenticate server session data before placing it in a cookie. */
export function sealPayload(payload: object, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}

export function unsealPayload(value: string, secret: string): unknown | null {
  try {
    const data = Buffer.from(value, "base64url");
    if (data.length < 30 || data[0] !== 1) {
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      sessionKey(secret),
      data.subarray(1, 13),
    );
    decipher.setAuthTag(data.subarray(13, 29));
    const plaintext = Buffer.concat([
      decipher.update(data.subarray(29)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch {
    return null;
  }
}

function sessionKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
