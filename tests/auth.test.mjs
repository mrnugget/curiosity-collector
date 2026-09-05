import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Server } from '../.svelte-kit/output/server/index.js';
import { manifest } from '../.svelte-kit/output/server/manifest.js';
import { sealPayload, unsealPayload } from '../src/lib/server/oauth.ts';

const secret = 'local-test-session-secret-not-for-production';
const origin = 'http://localhost:3000';
globalThis.fetch = async () => Response.json({ widget: null });
const server = new Server(manifest);
await server.init({ env: {
	NODE_ENV: 'production', DATABASE_PATH: ':memory:',
	AMP_OAUTH_CLIENT_ID: 'test-client', AMP_OAUTH_CLIENT_SECRET: 'test-client-secret',
	AMP_OAUTH_REDIRECT_URI: `${origin}/auth/callback`, COLLECTOR_SESSION_SECRET: secret,
	COLLECTOR_SHARE_TOKEN: 'test-share-token', COLLECTOR_PASSWORD: 'legacy-password',
	COLLECTOR_ALLOWED_USER_IDS: 'user_owner,user_01K9KJJDPFGCG05B1WFFETGX8E'
} });

function request(path, options = {}) {
	return server.respond(new Request(`${origin}${path}`, options), { getClientAddress: () => '127.0.0.1' });
}

function sessionCookie(id = 'user_owner', expiresAt = Date.now() + 60_000) {
	return `cc_amp_session=${sealPayload({ version: 1, user: { id, displayName: 'Test owner', email: null },
		tokens: { accessToken: 'test-token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }, expiresAt }, secret)}`;
}

test('production rejects anonymous notes/API/share and untrusted proxy identity', async () => {
	assert.equal((await request('/')).status, 303);
	assert.equal((await request('/api/items')).status, 401);
	assert.equal((await request('/api/items', { headers: { 'X-Amp-Authenticated': 'amp-user=yes, workspace-member=yes', 'X-Amp-User-ID': 'user_owner' } })).status, 401);
	assert.equal((await request('/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"blocked"}' })).status, 401);
	assert.equal((await request('/api/items', { headers: { cookie: 'cc_session=legacy-password-cookie' } })).status, 401);
});

test('sign-in uses real Amp PKCE/nonce contract, sealed transaction, safe return path', async () => {
	const response = await request('/auth/signin?returnTo=//evil.example');
	assert.equal(response.status, 302);
	const target = new URL(response.headers.get('location'));
	assert.equal(target.origin + target.pathname, 'https://auth.ampcode.com/oauth2/authorize');
	assert.equal(target.searchParams.get('scope'), 'openid profile email offline_access');
	assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
	assert.equal(target.searchParams.has('client_secret'), false);
	const cookie = response.headers.get('set-cookie');
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /SameSite=Lax/);
	const transaction = unsealPayload(cookie.match(/cc_oauth=([^;]+)/)[1], secret);
	assert.equal(transaction.returnTo, '/');
	assert.equal(transaction.state, target.searchParams.get('state'));
	assert.equal(transaction.nonce, target.searchParams.get('nonce'));
});

test('callback rejects absent, mismatched and expired transaction before token exchange', async () => {
	for (const cookie of ['', `cc_oauth=${sealPayload({ state: 'correct', nonce: 'n', codeVerifier: 'v'.repeat(43), returnTo: '/', expiresAt: Date.now() + 60_000 }, secret)}`,
		`cc_oauth=${sealPayload({ state: 'wrong', nonce: 'n', codeVerifier: 'v'.repeat(43), returnTo: '/', expiresAt: 1 }, secret)}`]) {
		const response = await request('/auth/callback?state=wrong&code=test', { headers: { cookie } });
		assert.equal(response.status, 303);
		assert.match(response.headers.get('location'), /auth_error=invalid_state/);
		assert.doesNotMatch(response.headers.get('set-cookie') ?? '', /cc_amp_session=/);
	}
});

test('successful callback verifies provider token and establishes a usable encrypted session', async (t) => {
	const start = await request('/auth/signin?returnTo=/');
	const cookie = start.headers.get('set-cookie').split(';')[0];
	const transaction = unsealPayload(cookie.slice('cc_oauth='.length), secret);
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
	const ownerID = 'user_01K9KJJDPFGCG05B1WFFETGX8E';
	const claims = Buffer.from(JSON.stringify({ iss: 'https://auth.ampcode.com', aud: 'test-client', sub: ownerID,
		exp: Math.floor(Date.now() / 1000) + 3600, nonce: transaction.nonce, name: 'Test owner' })).toString('base64url');
	const token = `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url')}`;
	t.mock.method(globalThis, 'fetch', async (input, init) => {
		if (input === 'https://auth.ampcode.com/oauth2/jwks') {
			return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key' }] });
		}
		assert.equal(input, 'https://auth.ampcode.com/oauth2/token');
		assert.equal(init.body.get('code_verifier'), transaction.codeVerifier);
		assert.equal(init.body.get('client_secret'), 'test-client-secret');
		return Response.json({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600, id_token: token });
	});
	const result = await request(`/auth/callback?code=valid&state=${transaction.state}`, { headers: { cookie } });
	assert.equal(result.status, 303);
	assert.equal(result.headers.get('location'), '/');
	const session = result.headers.getSetCookie().find((value) => value.startsWith('cc_amp_session='));
	assert.match(session, /HttpOnly/);
	assert.doesNotMatch(session, /test-token|test-refresh/);
	assert.equal(unsealPayload(session.split(';')[0].slice('cc_amp_session='.length), secret).user.id, ownerID);
	assert.equal((await request('/api/items', { headers: { cookie: session.split(';')[0] } })).status, 200);
});

test('valid session can read notes; expired and tampered sessions fail closed', async () => {
	const response = await request('/api/items', { headers: { cookie: sessionCookie() } });
	assert.equal(response.status, 200);
	assert.match(response.headers.get('cache-control'), /no-store/);
	assert.equal((await request('/api/items', { headers: { cookie: sessionCookie('user_owner', 1) } })).status, 401);
	assert.equal((await request('/api/items', { headers: { cookie: 'cc_amp_session=tampered' } })).status, 401);
});

test('Amp sign-in alone grants neither notes access nor sharing access', async () => {
	const headers = { cookie: sessionCookie('user_outsider') };
	assert.equal((await request('/')).status, 303);
	assert.equal((await request('/', { headers })).status, 403);
	assert.equal((await request('/api/items', { headers })).status, 403);
	assert.equal((await request('/share', { method: 'POST', headers })).status, 403);
	const login = await request('/login', { headers });
	assert.match(await login.text(), /This account is not allowed/);
});

test('only dedicated bearer credential authorizes machine sharing', async () => {
	const options = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer test-share-token' }, body: '{"text":"Shared in a test"}' };
	assert.equal((await request('/share', options)).status, 201);
	assert.equal((await request('/api/items', { headers: { authorization: 'Bearer test-share-token' } })).status, 401);
	assert.equal((await request('/share?key=test-share-token', { ...options, headers: { 'content-type': 'application/json' } })).status, 401);
	assert.equal((await request('/share', { ...options, headers: { ...options.headers, authorization: 'Bearer legacy-password' } })).status, 401);
	assert.equal((await request('/share?key=legacy-password', { ...options, headers: { 'content-type': 'application/json' } })).status, 401);
});

test('signout is POST-only, clears session, rejects cross-origin forms', async () => {
	assert.equal((await request('/auth/signout')).status, 405);
	const response = await request('/auth/signout', { method: 'POST', headers: { origin, cookie: sessionCookie() } });
	assert.equal(response.status, 303);
	assert.match(response.headers.get('set-cookie'), /cc_amp_session=;.*Max-Age=0/);
	assert.equal((await request('/auth/signout', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: '' })).status, 403);
});

test('widget capability is checked server-side without leaking OAuth token', async (t) => {
	const widget = { scriptURL: 'https://ampcode.com/jellyware/widget.js', appID: 'app_test' };
	t.mock.method(globalThis, 'fetch', async (input, init) => {
		assert.equal(input, 'https://ampcode.com/api/jellyware/context?app=amp/curiosity-collector');
		assert.equal(init.headers.Authorization, 'Bearer test-token');
		assert.equal(init.redirect, 'error');
		return Response.json({ widget });
	});
	const response = await request('/', { headers: { cookie: sessionCookie() } });
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.match(html, /https:\/\/ampcode.com\/jellyware\/widget.js/);
	assert.match(html, /app_test/);
	assert.doesNotMatch(html, /test-token|test-client-secret|accessToken/);
});

test('restored widget loader uses separate-page mode without app proxy calls', () => {
	const source = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	const effect = source.slice(source.indexOf('$effect('), source.indexOf('</script>'));
	let cleanup;
	let appended;
	let removed = false;
	const enabled = [];
	runInNewContext(effect, {
		data: { widget: { scriptURL: 'https://ampcode.com/jellyware/widget.js', appID: 'app_test' } },
		$effect: (callback) => { cleanup = callback(); },
		document: {
			createElement: (tag) => { assert.equal(tag, 'script'); return { dataset: {}, remove: () => { removed = true; } }; },
			head: { append: (script) => { appended = script; } }
		},
		window: { __ampJellyware: { setEnabled: (value) => enabled.push(value) } },
		fetch: () => { assert.fail('Separate-page loader must not call the app proxy'); }
	});
	assert.equal(appended.src, 'https://ampcode.com/jellyware/widget.js');
	assert.equal(appended.dataset.jellywareApp, 'app_test');
	assert.equal(appended.dataset.jellywareInline, undefined);
	assert.equal(appended.async, true);
	cleanup();
	appended.onload();
	assert.equal(removed, true);
	assert.deepEqual(enabled, [false, false]);
});

test('temporary diagnostic and inline proxy routes are removed', async () => {
	const headers = { cookie: sessionCookie() };
	assert.equal((await request('/__oauth-lifecycle', { headers })).status, 404);
	assert.equal((await request('/api/jellyware', { headers })).status, 404);
});

test('denied, unavailable and malformed widget capability never break notes', async (t) => {
	for (const result of [null, 401, 503, 'offline', { scriptURL: 'https://evil.example/widget.js', appID: 'app_test' }]) {
		const mock = t.mock.method(globalThis, 'fetch', async () => {
			if (result === 'offline') throw new Error('offline');
			return typeof result === 'number' ? new Response('', { status: result }) : Response.json({ widget: result });
		});
		const response = await request('/', { headers: { cookie: sessionCookie() } });
		assert.equal(response.status, 200);
		const html = await response.text();
		assert.doesNotMatch(html, /app_test|test-token|widget\.js/);
		mock.mock.restore();
	}
});
