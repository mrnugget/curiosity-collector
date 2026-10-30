import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { Server } from '../.svelte-kit/output/server/index.js';
import { manifest } from '../.svelte-kit/output/server/manifest.js';

test('legacy password preserves only machine sharing when the dedicated token is unset', async () => {
	const password = 'legacy-test-password';
	const server = new Server(manifest);
	await server.init({ env: { NODE_ENV: 'production', DATABASE_PATH: ':memory:', COLLECTOR_PASSWORD: password } });
	const request = (path, options = {}) => server.respond(new Request(`http://localhost${path}`, options), { getClientAddress: () => '127.0.0.1' });
	const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${password}` };
	assert.equal((await request('/share', { method: 'POST', headers, body: '{"text":"Legacy Shortcut"}' })).status, 201);
	assert.equal((await request(`/share?key=${password}&text=Legacy+bookmarklet`, { headers: { accept: 'application/json' } })).status, 201);
	assert.equal((await request('/share?key=wrong&text=Rejected', { headers: { accept: 'application/json' } })).status, 401);
	assert.equal((await request('/share', { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: '{"text":"Rejected"}' })).status, 401);
	assert.equal((await request('/api/items', { headers })).status, 401);
	const legacySession = createHmac('sha256', password).update('curiosity-collector-session').digest('hex');
	assert.equal((await request('/api/items', { headers: { cookie: `cc_session=${legacySession}` } })).status, 401);
	assert.equal((await request('/')).status, 303);
	assert.equal((await request('/login', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${password}` })).status, 405);
	const login = await (await request('/login', { headers })).text();
	assert.doesNotMatch(login, /widget\.js|Signed in as/);
});
