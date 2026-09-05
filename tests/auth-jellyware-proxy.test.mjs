import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Server } from '../.svelte-kit/output/server/index.js';
import { manifest } from '../.svelte-kit/output/server/manifest.js';
import { sealPayload } from '../src/lib/server/oauth.ts';

const origin = 'https://collector.example.com';
const secret = 'local-jellyware-proxy-secret-not-for-production';
const upstream = 'https://ampcode.com/api/jellyware/launch?app=amp/curiosity-collector';
const requestID = '12345678-1234-4234-8234-123456789012';
const threadURL = `https://ampcode.com/threads/T-${requestID}`;
const authorizationURL = 'https://ampcode.com/jellyware/authorize/grant_test';
const discovery = { appID: 'app_test', appName: 'Collector', destinations: {
	orb: { available: true, authorized: false, reason: null },
	obelisk: { available: false, authorized: false, reason: 'Runner owner required' }
} };
const send = { action: 'send', destination: 'orb', requestID, comments: [{ comment: 'Fix this', page: `${origin}/` }] };
const authorize = { action: 'authorize', destination: 'orb' };
globalThis.fetch = async () => { throw new Error('Unexpected external request'); };
const server = new Server(manifest);
await server.init({ env: { NODE_ENV: 'production', DATABASE_PATH: ':memory:',
	AMP_OAUTH_CLIENT_ID: 'test-client', AMP_OAUTH_CLIENT_SECRET: 'test-client-secret',
	AMP_OAUTH_REDIRECT_URI: `${origin}/auth/callback`, COLLECTOR_SESSION_SECRET: secret,
	COLLECTOR_ALLOWED_USER_IDS: 'notes_user', COLLECTOR_SHARE_TOKEN: 'share-token', COLLECTOR_PASSWORD: 'old-password'
} });

function cookie({ id = 'platform_user', refresh = false } = {}) {
	return `cc_amp_session=${sealPayload({ version: 1, user: { id, displayName: 'Test', email: null },
		tokens: { accessToken: 'server-token', refreshToken: refresh ? 'refresh-token' : null, expiresAt: Date.now() + (refresh ? 1 : 3_600_000) },
		expiresAt: Date.now() + 3_600_000 }, secret)}`;
}

function request(payload, options = {}) {
	const headers = { cookie: cookie(), ...(payload !== undefined ? { origin, 'content-type': 'application/json' } : {}), ...options.headers };
	return server.respond(new Request(`${origin}/api/jellyware${options.query ?? ''}`, {
		method: payload === undefined ? 'GET' : 'POST',
		headers, body: options.body ?? (payload === undefined ? undefined : JSON.stringify(payload)),
		...(options.duplex ? { duplex: 'half' } : {})
	}), { getClientAddress: () => '127.0.0.1' });
}

test('Jellyware requires OAuth, not sharing credentials or notes permission', async (t) => {
	const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(discovery));
	for (const headers of [{ cookie: '' }, { cookie: 'cc_session=old', authorization: 'Bearer old-password' }, { cookie: '', authorization: 'Bearer share-token' }]) {
		assert.equal((await request(undefined, { headers })).status, 401);
		assert.equal((await request(authorize, { headers })).status, 401);
	}
	assert.equal(mock.mock.callCount(), 0);
	// The valid platform user is deliberately absent from the notes allowlist.
	assert.equal((await request()).status, 200);
	mock.mock.restore();
	t.mock.method(globalThis, 'fetch', async () => new Response('upstream secret', { status: 403 }));
	assert.equal((await request(send, { headers: { cookie: cookie({ id: 'notes_user' }) } })).status, 403);
});

test('Jellyware POST enforces exact configured Origin, JSON and bounded actual bytes', async (t) => {
	const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ authorizationURL }));
	for (const value of ['', 'null', 'https://evil.example', `${origin}/`, 'http://collector.example.com']) {
		assert.equal((await request(authorize, { headers: { origin: value } })).status, 403);
	}
	assert.equal((await request(authorize, { headers: { 'content-type': 'text/plain' } })).status, 415);
	assert.equal((await request(authorize, { body: '{' })).status, 400);
	assert.equal((await request(authorize, { headers: { 'content-length': '200001' } })).status, 413);
	assert.equal((await request(authorize, { body: ' '.repeat(200001) })).status, 413);
	assert.equal((await request(authorize, { body: ' '.repeat(200001), headers: { 'content-length': '1' } })).status, 413);
	const stream = new ReadableStream({ start(controller) {
		controller.enqueue(new Uint8Array(100001)); controller.enqueue(new Uint8Array(100001)); controller.close();
	} });
	assert.equal((await request(authorize, { body: stream, duplex: true })).status, 413);
	assert.equal(mock.mock.callCount(), 0);
});

test('Jellyware validates commands/comments and refuses browser routing overrides', async (t) => {
	const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ threadURL }));
	for (const payload of [null, {}, { ...authorize, destination: 'runner' }, { ...send, requestID: 'not-uuid' },
		...['app', 'client', 'runner', 'origin'].map((key) => ({ ...send, [key]: 'override' })),
		{ ...send, comments: [] }, { ...send, comments: Array(21).fill(send.comments[0]) },
		...[null, { comment: ' ', page: origin }, { comment: 'x'.repeat(4001), page: origin },
			{ comment: 'x', page: 'x'.repeat(2001) }, { ...send.comments[0], target: { selector: 'x', snippet: 'x', source: { line: -1 } } },
			{ ...send.comments[0], viewport: { width: 1.2, height: 1 } }].map((comment) => ({ ...send, comments: [comment] }))]) {
		assert.equal((await request(payload)).status, 400);
	}
	assert.equal(mock.mock.callCount(), 0);
});

test('Jellyware GET relays only refreshed identity and validated uncached discovery', async (t) => {
	let calls = 0;
	const timeouts = [];
	t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
		timeouts.push(milliseconds);
		return new AbortController().signal;
	});
	t.mock.method(globalThis, 'fetch', async (input, init) => {
		if (input === 'https://auth.ampcode.com/oauth2/token') return Response.json({ access_token: 'refreshed-server-token', expires_in: 3600 });
		calls++;
		assert.equal(input, upstream);
		assert.equal(init.headers.Authorization, 'Bearer refreshed-server-token');
		assert.equal(init.redirect, 'error');
		assert.equal(init.cache, 'no-store');
		assert.equal(init.method, 'GET');
		return Response.json({ ...discovery, accessToken: 'must-not-leak', runner: 'secret', destinations: {
			...discovery.destinations, orb: { ...discovery.destinations.orb, secret: 'must-not-leak' }
		} });
	});
	for (let i = 0; i < 2; i++) {
		const response = await request(undefined, { headers: { cookie: cookie({ refresh: true }) }, query: '?app=evil&runner=evil' });
		assert.equal(response.status, 200);
		assert.match(response.headers.get('cache-control'), /no-store/);
		assert.deepEqual(await response.json(), discovery);
	}
	assert.equal(calls, 2);
	assert.deepEqual(timeouts, [30_000, 30_000]);
});

test('Jellyware POST strips comment extras, preserves requestID and validates result URLs', async (t) => {
	const timeouts = [];
	t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
		timeouts.push(milliseconds);
		return new AbortController().signal;
	});
	const cleanComment = { comment: 'Fix this', page: origin, target: { selector: '.button', snippet: 'Send', source: { framework: 'svelte', file: 'src/a.svelte', line: 3, column: 4, component: 'Button' } }, viewport: { width: 1000, height: 800 } };
	const input = { ...send, destination: 'obelisk', comments: [{ ...cleanComment, comment: ' Fix this ', runner: 'strip', target: { ...cleanComment.target, extra: 'strip', source: { ...cleanComment.target.source, extra: 'strip' } }, viewport: { ...cleanComment.viewport, extra: 'strip' } }] };
	t.mock.method(globalThis, 'fetch', async (url, init) => {
		assert.equal(url, upstream);
		assert.equal(init.method, 'POST');
		assert.equal(init.headers.Authorization, 'Bearer server-token');
		assert.equal(init.headers['Content-Type'], 'application/json');
		assert.equal(init.redirect, 'error');
		const payload = JSON.parse(init.body);
		assert.deepEqual(payload, payload.action === 'authorize' ? authorize : { ...send, destination: 'obelisk', comments: [cleanComment] });
		return Response.json(payload.action === 'authorize' ? { authorizationURL, token: 'strip' } : { threadURL, token: 'strip' });
	});
	assert.deepEqual(await (await request(authorize)).json(), { authorizationURL });
	assert.deepEqual(await (await request(input)).json(), { threadURL });
	assert.deepEqual(timeouts, [30_000, 60_000]);
});

test('Jellyware strips upstream errors and rejects unsafe URLs/invalid responses', async (t) => {
	for (const status of [302, 400, 401, 403, 409, 429, 500, 503]) {
		const mock = t.mock.method(globalThis, 'fetch', async () => new Response('upstream-secret-detail', { status, headers: { location: 'https://evil.example' } }));
		const response = await request(send);
		assert.equal(response.status, [302, 500].includes(status) ? 502 : status);
		assert.doesNotMatch(await response.text(), /upstream-secret-detail/);
		assert.equal(response.headers.get('location'), null);
		mock.mock.restore();
	}
	for (const url of ['https://evil.example/threads/T-123', 'https://ampcode.com@evil.example/threads/T-123', 'http://ampcode.com/threads/T-123', `${threadURL}?token=leak`, `${threadURL}#leak`, authorizationURL, 'javascript:alert(1)']) {
		const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ threadURL: url }));
		assert.equal((await request(send)).status, 502);
		mock.mock.restore();
	}
	for (const data of [null, {}, { ...discovery, destinations: { orb: { available: 'true' } } }, { ...discovery, appName: 42 }]) {
		const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(data));
		assert.equal((await request()).status, 502);
		mock.mock.restore();
	}
	for (const url of ['https://evil.example/jellyware/authorize/grant', `${authorizationURL}?token=leak`, threadURL]) {
		const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ authorizationURL: url }));
		assert.equal((await request(authorize)).status, 502);
		mock.mock.restore();
	}
	for (const body of ['not-json', ' '.repeat(200001)]) {
		const mock = t.mock.method(globalThis, 'fetch', async () => new Response(body));
		assert.equal((await request()).status, 502);
		mock.mock.restore();
	}
	for (const error of [new TypeError('redirect with secret'), new DOMException('secret', 'TimeoutError')]) {
		const mock = t.mock.method(globalThis, 'fetch', async () => { throw error; });
		const response = await request(send);
		assert.equal(response.status, error.name === 'TimeoutError' ? 504 : 502);
		assert.doesNotMatch(await response.text(), /secret/);
		mock.mock.restore();
	}
});
