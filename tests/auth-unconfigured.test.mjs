import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Server } from '../.svelte-kit/output/server/index.js';
import { manifest } from '../.svelte-kit/output/server/manifest.js';
import { sealPayload } from '../src/lib/server/oauth.ts';

test('production without OAuth or allowlist fails closed, even with a valid session', async () => {
	const secret = 'local-test-secret-not-for-production';
	const server = new Server(manifest);
	await server.init({ env: { NODE_ENV: 'production', DATABASE_PATH: ':memory:', COLLECTOR_SESSION_SECRET: secret } });
	const request = (path, cookie = '') => server.respond(new Request(`http://localhost${path}`, { headers: { cookie } }), { getClientAddress: () => '127.0.0.1' });
	assert.equal((await request('/api/items')).status, 401);
	assert.equal((await request('/auth/signin')).status, 503);
	assert.match(await (await request('/login')).text(), /Amp sign-in is not configured/);
	const session = sealPayload({ version: 1, user: { id: 'user_owner', displayName: 'Owner', email: null },
		tokens: { accessToken: 'test-token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }, expiresAt: Date.now() + 60_000 }, secret);
	assert.equal((await request('/api/items', `cc_amp_session=${session}`)).status, 403);
});
