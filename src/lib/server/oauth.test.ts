import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signPayload,
} from "node:crypto";
import { test } from "node:test";
import {
  buildAuthorizationURL,
  exchangeAuthorizationCode,
  normalizeReturnTo,
  refreshAccessToken,
  sealPayload,
  unsealPayload,
  type OAuthConfig,
} from "./oauth.ts";

const config: OAuthConfig = {
  issuer: "https://auth.ampcode.com",
  authorizationURL: "https://auth.ampcode.com/oauth2/authorize",
  tokenURL: "https://auth.ampcode.com/oauth2/token",
  jwksURL: "https://auth.ampcode.com/oauth2/jwks",
  resourceURL: "https://ampcode.com/api/v2",
  clientID: "client_jelly",
  clientSecret: "server-only-secret",
  redirectURI: "https://docs.example.com/auth/callback",
};

test("authorization URL uses Amp's confidential authorization-code contract", () => {
  const codeVerifier = "v".repeat(43);
  const url = new URL(
    buildAuthorizationURL(config, {
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier,
      returnTo: "/bugs/1",
      expiresAt: Date.now() + 60_000,
    }),
  );
  assert.equal(url.origin + url.pathname, config.authorizationURL);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: config.clientID,
    code_challenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    nonce: "nonce-value",
    redirect_uri: config.redirectURI,
    resource: config.resourceURL,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "state-value",
  });
});

test("token exchange sends credentials only in the server-to-server form body", async () => {
  const requests: Request[] = [];
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicJWK = {
    ...publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  };
  const idToken = signIDToken(
    {
      iss: config.issuer,
      aud: config.clientID,
      exp: 3_601,
      sub: "user_jelly",
      nonce: "nonce-value",
      name: "Docs Writer",
      given_name: "Docs",
      family_name: "Writer",
      email: "docs@example.com",
    },
    privateKey,
  );
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url === config.jwksURL) {
      return Response.json({ keys: [publicJWK] });
    }
    return Response.json({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      id_token: idToken,
      token_type: "bearer",
    });
  };
  const result = await exchangeAuthorizationCode(
    config,
    "authorization-code",
    "v".repeat(43),
    "nonce-value",
    fetchFn,
    1_000,
  );
  const request = requests[0];
  assert(request);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), null);
  const body = new URLSearchParams(await request.text());
  assert.equal(body.get("client_id"), config.clientID);
  assert.equal(body.get("client_secret"), config.clientSecret);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "authorization-code");
  assert.equal(body.get("code_verifier"), "v".repeat(43));
  assert.equal(body.get("redirect_uri"), config.redirectURI);
  assert.equal(body.get("resource"), config.resourceURL);
  assert.deepEqual(result, {
    identity: {
      sub: "user_jelly",
      name: "Docs Writer",
      givenName: "Docs",
      familyName: "Writer",
      email: "docs@example.com",
    },
    tokens: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 3_601_000,
    },
  });
  await assert.rejects(
    exchangeAuthorizationCode(
      config,
      "authorization-code",
      "v".repeat(43),
      "different-nonce",
      fetchFn,
      1_000,
    ),
    /ID token claims are invalid/,
  );
});

test('ID token rejects invalid signatures and issuer, audience, time and identity claims', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const valid = { iss: config.issuer, aud: config.clientID, sub: 'user_test', exp: 3601, nonce: 'n' };
  for (const patch of [
    { iss: 'https://evil.example' }, { aud: 'other-client' }, { exp: 1 },
    { nbf: 1000 }, { sub: '' }, { nonce: 'wrong' }, { azp: 'other-client' },
    { aud: [config.clientID, 'other-client'] }
  ]) {
    await assert.rejects(exchangeAuthorizationCode(config, 'code', 'v'.repeat(43), 'n',
      async (input) => String(input) === config.jwksURL
        ? Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key' }] })
        : Response.json({ access_token: 'access', id_token: signIDToken({ ...valid, ...patch }, privateKey) }),
      1000), /ID token claims are invalid/);
  }
  await assert.rejects(exchangeAuthorizationCode(config, 'code', 'v'.repeat(43), 'n',
    async (input) => String(input) === config.jwksURL
      ? Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key' }] })
      : Response.json({ access_token: 'access', id_token: signIDToken(valid, wrongKey) }),
    1000), /signature is invalid/);
});

test("token refresh preserves the requested Amp API resource", async () => {
  const requests: Request[] = [];
  const tokens = await refreshAccessToken(
    config,
    "current-refresh-token",
    async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        access_token: "refreshed-access-token",
        refresh_token: "replacement-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
      });
    },
    1_000,
  );
  const request = requests[0];
  assert(request);
  const body = new URLSearchParams(await request.text());
  assert.equal(body.get("client_id"), config.clientID);
  assert.equal(body.get("client_secret"), config.clientSecret);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "current-refresh-token");
  assert.equal(body.get("resource"), config.resourceURL);
  assert.deepEqual(tokens, {
    accessToken: "refreshed-access-token",
    refreshToken: "replacement-refresh-token",
    expiresAt: 3_601_000,
  });
});

test("sealed session payload rejects tampering and the wrong secret", () => {
  const value = sealPayload({ accessToken: "not-visible" }, "a".repeat(32));
  assert.deepEqual(unsealPayload(value, "a".repeat(32)), {
    accessToken: "not-visible",
  });
  assert.equal(unsealPayload(value, "b".repeat(32)), null);
  const tamperIndex = 20;
  const tampered = `${value.slice(0, tamperIndex)}${value[tamperIndex] === "A" ? "B" : "A"}${value.slice(tamperIndex + 1)}`;
  assert.equal(unsealPayload(tampered, "a".repeat(32)), null);
});

test("return paths cannot escape the app origin", () => {
  const fallback = "/@amp/jelly-bug-tracker";
  assert.equal(
    normalizeReturnTo("/@amp/jelly-bug-tracker/doc/a.md?mode=view", fallback),
    "/@amp/jelly-bug-tracker/doc/a.md?mode=view",
  );
  assert.equal(normalizeReturnTo("https://evil.example", fallback), fallback);
  assert.equal(normalizeReturnTo("//evil.example/path", fallback), fallback);
  assert.equal(normalizeReturnTo("/\\evil.example/path", fallback), fallback);
});

function signIDToken(
  claims: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = signPayload("RSA-SHA256", Buffer.from(input), privateKey).toString(
    "base64url",
  );
  return `${input}.${signature}`;
}
