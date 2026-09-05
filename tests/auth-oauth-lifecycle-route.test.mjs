import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Server } from '../.svelte-kit/output/server/index.js';
import { manifest } from '../.svelte-kit/output/server/manifest.js';
import { sealPayload } from '../src/lib/server/oauth.ts';

const origin = 'https://harness.example';
const base = '/__oauth-lifecycle';
const secret = 'local-only-lifecycle-session-secret';
const server = new Server(manifest);
await server.init({ env: {
	NODE_ENV: 'production', DATABASE_PATH: ':memory:', COLLECTOR_SESSION_SECRET: secret,
	AMP_OAUTH_CLIENT_ID: 'test-client', AMP_OAUTH_CLIENT_SECRET: 'test-secret',
	AMP_OAUTH_REDIRECT_URI: `${origin}/auth/callback`
} });
const request = (path, options = {}) => server.respond(new Request(`${origin}${path}`, options), { getClientAddress: () => '127.0.0.1' });

test('temporary route isolates cookies, bounds controls and keeps notes protected', async () => {
	// A normal expired app token must not be refreshed or its session cookie touched.
	const appCookie = `cc_amp_session=${sealPayload({ version: 1, user: { id: 'owner' }, tokens: {
		accessToken: 'mock-token', refreshToken: 'mock-refresh', expiresAt: 1
	}, expiresAt: Date.now() + 60_000 }, secret)}`;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => { throw new Error('Normal app refresh must not run'); };
	try {
		const start = await request(base, { headers: { cookie: appCookie } });
		assert.equal(start.status, 200);
		const html = await start.text();
		assert.match(html, /action="\/__oauth-lifecycle\/signin-a"/);
		assert.match(html, /"tokenAReceived": false/);
		assert.match(start.headers.get('cache-control'), /no-store/);
		assert.equal(start.headers.get('x-frame-options'), 'DENY');
		assert.equal(start.headers.get('x-amp-review-widget'), 'off');
		assert.doesNotMatch(start.headers.get('set-cookie'), /cc_amp_session/);
		const cookie = start.headers.get('set-cookie').split(';')[0];
		const post = (step, extra = {}) => request(`${base}/${step}`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded', ...extra } });
		assert.equal((await post('signin-a', { origin: 'https://evil.example' })).status, 403);
		const authorize = await post('signin-a');
		assert.equal(authorize.status, 303);
		const target = new URL(authorize.headers.get('location'));
		assert.equal(target.searchParams.get('redirect_uri'), `${origin}${base}/auth/callback`);
		assert.equal(target.searchParams.get('resource'), 'https://ampcode.com/api/v2');
		assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
		const invalid = await request(`${base}/auth/callback?state=wrong&code=fake`, { headers: { cookie } });
		assert.equal(invalid.headers.get('location'), base);
		assert.match(await (await request(base, { headers: { cookie } })).text(), /"error": "invalid_state"/);
		assert.equal((await post('signin-b')).status, 409);
		assert.equal((await post('check-both')).status, 403);
		assert.equal((await post('unknown')).status, 404);
		assert.equal((await request(`${base}/signin-a`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'unexpected=body' })).status, 400);
		assert.equal((await request('/api/items', { headers: { cookie } })).status, 401);
		assert.equal((await request('/__oauth-lifecycle-other', { headers: { cookie } })).status, 303);
		await post('reset');
		assert.equal((await post('check-a')).status, 401);
	} finally { globalThis.fetch = originalFetch; }
});
