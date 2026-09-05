import { request as httpsRequest } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { buildAuthorizationURL, createOAuthTransaction, exchangeAuthorizationCode } from './oauth.ts';

// Temporary owner-coordinated diagnostic. Remove after the lifecycle test.
export const BASE_PATH = '/__oauth-lifecycle';

const ISSUER = 'https://auth.ampcode.com';
const COOKIE = '__Host-cc_oauth_lifecycle';
const OWNER = 'user_01K9KJJDPFGCG05B1WFFETGX8E';
const TTL = 60 * 60 * 1000;
const RESPONSE_LIMIT = 64 * 1024;

type Claims = Record<string, unknown>;
type Token = { accessToken: string; expiresAt: number | null; claims: Claims | null; sid: string | null };
type Probe = { status: number | null; active: boolean | null; expired: boolean | null; checks?: Record<string, boolean> | null };
type Session = {
	expiresAt: number; ownerVerified: boolean; busy: boolean;
	a?: Token; b?: Token; before?: Probe; after?: Probe;
	final?: { a: Probe; b: Probe; expected: boolean; strictFieldChecksPassed: boolean };
	error?: 'invalid_state' | 'owner_mismatch' | 'sign_in_failed' | null;
	transaction?: ReturnType<typeof createOAuthTransaction> & { slot: 'a' | 'b' };
};

// No redirects, no insecure TLS overrides, no request/response logging.
export const providerFetch: typeof fetch = (input, init = {}) => {
	const url = new URL(String(input));
	if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash ||
		!['/oauth2/token', '/oauth2/jwks', '/oauth2/introspection'].includes(url.pathname)) {
		return Promise.reject(new Error('provider_request_rejected'));
	}
	const body = init.body ? String(init.body) : undefined;
	return new Promise<Response>((resolve, reject) => {
		const req = httpsRequest(url, {
			method: init.method ?? 'GET', rejectUnauthorized: true,
			signal: AbortSignal.timeout(15_000),
			headers: { ...Object.fromEntries(new Headers(init.headers)), ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
		}, (res) => {
			if (!res.statusCode || (res.statusCode >= 300 && res.statusCode < 400)) {
				res.resume(); reject(new Error('provider_redirect_rejected')); return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			res.on('data', (chunk) => {
				size += chunk.length;
				if (size > RESPONSE_LIMIT) {
					res.destroy(); reject(new Error('provider_response_too_large')); return;
				}
				chunks.push(chunk);
			});
			res.on('error', () => reject(new Error('provider_transport_failed')));
			res.on('end', () => {
				const bytes = Buffer.concat(chunks);
				resolve(new Response(res.statusCode === 204 ? null : bytes, { status: res.statusCode }));
			});
		});
		req.on('error', () => reject(new Error('provider_transport_failed')));
		req.end(body);
	});
}

function equals(a: string, b: string) {
	const aa = Buffer.from(a); const bb = Buffer.from(b);
	return aa.length === bb.length && timingSafeEqual(aa, bb);
}

// Diagnostic only, never an authentication or consent decision. Opaque tokens return null.
function diagnosticClaims(accessToken: string): Claims | null {
	try {
		const parts = accessToken.split('.');
		if (parts.length !== 3) return null;
		const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
		return claims && typeof claims === 'object' ? claims : null;
	} catch { return null; }
}

export function introspectionChecks(payload: Claims | null, claims: Claims | null, clientID: string, ownerID: string, now: number) {
	const nonempty = (v: unknown) => typeof v === 'string' && v.length > 0;
	return {
		subMatchesOwner: payload?.sub === ownerID,
		subMatchesToken: nonempty(payload?.sub) && payload?.sub === claims?.sub,
		clientMatchesConfigured: payload?.client_id === clientID,
		clientMatchesToken: nonempty(payload?.client_id) && payload?.client_id === claims?.client_id,
		issuerMatches: payload?.iss === ISSUER && payload.iss === claims?.iss,
		audienceIsString: typeof payload?.aud === 'string',
		audienceMatchesResource: payload?.aud === 'https://ampcode.com/api/v2',
		audienceMatchesTokenExact: typeof payload?.aud === 'string' && payload.aud === claims?.aud,
		sidMatchesToken: nonempty(payload?.sid) && payload?.sid === claims?.sid,
		jtiMatchesToken: nonempty(payload?.jti) && payload?.jti === claims?.jti,
		expMatchesToken: Number.isFinite(payload?.exp) && payload?.exp === claims?.exp,
		expUnexpired: typeof payload?.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > Math.floor(now / 1000),
		tokenTypeAccessToken: payload?.token_type === 'access_token',
		tokenTypeBearer: typeof payload?.token_type === 'string' && payload.token_type.toLowerCase() === 'bearer'
	};
}

export function strictFieldChecksPassed(checks: Record<string, boolean> | null | undefined) {
	// Bearer is diagnostic only, not the platform introspection token type.
	return !!checks && Object.entries(checks).filter(([key]) => key !== 'tokenTypeBearer').every(([, value]) => value === true);
}

export function createHarness({ origin, clientID, clientSecret, ownerID = OWNER, fetchFn = providerFetch, now = Date.now }: {
	origin: string; clientID: string; clientSecret: string; ownerID?: string; fetchFn?: typeof fetch; now?: () => number;
}) {
	const publicURL = new URL(origin);
	if (publicURL.protocol !== 'https:' || origin !== publicURL.origin || publicURL.username || publicURL.password ||
		!clientID || !clientSecret || !ownerID) throw new Error('invalid_harness_configuration');
	const config = {
		issuer: ISSUER, authorizationURL: `${ISSUER}/oauth2/authorize`, tokenURL: `${ISSUER}/oauth2/token`,
		jwksURL: `${ISSUER}/oauth2/jwks`, resourceURL: 'https://ampcode.com/api/v2',
		clientID, clientSecret, redirectURI: `${origin}${BASE_PATH}/auth/callback`
	};
	const sessions = new Map<string, Session>();
	function expire() {
		for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
	}
	const timer = setInterval(expire, 30_000);
	timer.unref();
	function headers(extra: Record<string, string> = {}) {
		return {
			'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
			'x-amp-review-widget': 'off',
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.ampcode.com; frame-ancestors 'none'; base-uri 'none'",
			'x-content-type-options': 'nosniff', ...extra
		};
	}
	function plain(message: string, status: number) { return new Response(message, { status, headers: headers({ 'content-type': 'text/plain; charset=utf-8' }) }); }
	function redirect(location: string, extra: Record<string, string> = {}) { return new Response(null, { status: 303, headers: headers({ location: location.startsWith('/') ? `${BASE_PATH}${location === '/' ? '' : location}` : location, ...extra }) }); }
	function evidence(session: Session) {
		return {
			ownerVerified: session.ownerVerified,
			tokenAReceived: !!session.a, tokenBReceived: !!session.b,
			beforeRevocation: session.before ?? null,
			afterRevocation: session.after ?? null,
			afterReconsent: session.final ?? null,
			sidAvailableA: session.a ? session.a.sid !== null : null,
			sidAvailableB: session.b ? session.b.sid !== null : null,
			sidEqual: session.a?.sid && session.b?.sid ? session.a.sid === session.b.sid : null,
			error: session.error ?? null
		};
	}
	function page(session: Session, setCookie?: string) {
		// evidence contains only fixed labels, booleans, status numbers and nulls.
		const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Curiosity OAuth lifecycle test</title>
<style>body{font:16px system-ui;max-width:48rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.6rem;margin:.3rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:1rem}form{display:inline-block;margin-right:1rem}</style>
<h1>Curiosity OAuth lifecycle test</h1><p>Owner only. This harness never revokes consent, changes notes, or launches agents. Tokens stay in server memory for at most one hour.</p>
<ol><li>Sign in for token A and verify active.</li><li>Coordinate revocation with the agent before revoking Curiosity in Amp. Then check token A.</li><li>Only after token A is inactive and unexpired, sign in again for token B.</li></ol>
<form method="POST" action="${BASE_PATH}/signin-a"><button ${session.a ? 'disabled' : ''}>1. Sign in for token A</button></form>
<form method="POST" action="${BASE_PATH}/check-a"><button ${session.a && !session.b ? '' : 'disabled'}>2. Check token A after revocation</button></form>
<form method="POST" action="${BASE_PATH}/signin-b"><button ${session.after?.active === false && session.after?.expired === false && !session.b ? '' : 'disabled'}>3. Reconsent for token B</button></form>
<form method="POST" action="${BASE_PATH}/check-both"><button ${session.b ? '' : 'disabled'}>Recheck A and B</button></form>
<form method="POST" action="${BASE_PATH}/reset"><button>Forget test tokens</button></form>
<h2>Safe evidence</h2><pre>${JSON.stringify(evidence(session), null, 2)}</pre>
<p>sid equality is diagnostic only; it is not proof of current consent. Restart or Forget clears this browser's test. Expired access tokens cannot prove revocation.</p></html>`;
		return new Response(html, { headers: headers({ 'content-type': 'text/html; charset=utf-8', ...(setCookie ? { 'set-cookie': setCookie } : {}) }) });
	}
	async function introspect(token: Token): Promise<Probe> {
		try {
			const result = await fetchFn(`${ISSUER}/oauth2/introspection`, {
				method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({ client_id: clientID, client_secret: clientSecret, token: token.accessToken, token_type_hint: 'access_token' })
			});
			const payload = await result.json().catch(() => null);
			return { status: result.status, active: result.status === 200 && typeof payload?.active === 'boolean' ? payload.active : null,
				checks: result.status === 200 && payload?.active === true ? introspectionChecks(payload, token.claims, clientID, ownerID, now()) : null,
				expired: token.expiresAt === null ? null : token.expiresAt <= now() };
		} catch { return { status: null, active: null, expired: token.expiresAt === null ? null : token.expiresAt <= now() }; }
	}
	async function checkBoth(session: Session) {
		if (!session.a || !session.b) return;
		const a = await introspect(session.a);
		const b = await introspect(session.b);
		session.final = { a, b, expected: a.active === false && a.expired === false && b.active === true,
			strictFieldChecksPassed: strictFieldChecksPassed(b.checks) };
	}
	async function handle(request: Request) {
		expire();
		const url = new URL(request.url);
		if (url.origin !== origin) return plain('Wrong origin.', 400);
		if (url.pathname !== BASE_PATH && !url.pathname.startsWith(`${BASE_PATH}/`)) return plain('Not found.', 404);
		url.pathname = url.pathname.slice(BASE_PATH.length) || '/';
		const cookie = (request.headers.get('cookie') ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
		let session = cookie ? sessions.get(cookie) : null;
		if (request.method === 'GET' && url.pathname === '/') {
			if (session) return page(session);
			if (sessions.size >= 8) return plain('Test capacity reached. Try later.', 503);
			const id = randomBytes(32).toString('base64url');
			session = { expiresAt: now() + TTL, ownerVerified: false, busy: false };
			sessions.set(id, session);
			return page(session, `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`);
		}
		if (!session) return plain('Open the test start page first.', 401);
		if (request.method === 'GET' && url.pathname === '/auth/callback') {
			const transaction = session.transaction;
			delete session.transaction;
			if (!transaction || transaction.expiresAt <= now() || !equals(url.searchParams.get('state') ?? '', transaction.state)) {
				session.error = 'invalid_state'; return redirect('/');
			}
			if (session.busy) return plain('Request already in progress.', 409);
			session.busy = true;
			try {
				if (url.searchParams.has('error') || !url.searchParams.get('code')) throw new Error('oauth_failed');
				const result = await exchangeAuthorizationCode(config, url.searchParams.get('code')!, transaction.codeVerifier, transaction.nonce, fetchFn, now());
				if (result.identity.sub !== ownerID) { session.error = 'owner_mismatch'; return redirect('/'); }
				const claims = diagnosticClaims(result.tokens.accessToken);
				const token = { accessToken: result.tokens.accessToken, expiresAt: result.tokens.expiresAt, claims, sid: typeof claims?.sid === 'string' && claims.sid ? claims.sid : null };
				// Refresh/ID tokens are not retained. No refresh: preserve the original tokens for the comparison.
				session.ownerVerified = true;
				session.error = null;
				if (transaction.slot === 'a') {
					session.a = token;
					session.before = await introspect(token);
				} else {
					session.b = token;
					await checkBoth(session);
				}
			} catch { session.error = 'sign_in_failed'; }
			finally { session.busy = false; }
			return redirect('/');
		}
		if (request.method !== 'POST') return plain('Not found.', 404);
		if (request.headers.get('origin') !== origin) return plain('Invalid request origin.', 403);
		if (session.busy) return plain('Request already in progress.', 409);
		if (url.pathname === '/reset') {
			sessions.delete(cookie!);
			return redirect('/', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
		}
		if (url.pathname === '/signin-a' || url.pathname === '/signin-b') {
			const slot = url.pathname === '/signin-a' ? 'a' : 'b';
			if ((slot === 'a' && session.a) || (slot === 'b' && (!session.a || session.b || session.before?.active !== true || session.after?.active !== false || session.after?.expired !== false))) {
				return plain('Complete the preceding test step first.', 409);
			}
			session.transaction = { ...createOAuthTransaction('/', now()), slot };
			session.error = null;
			return redirect(buildAuthorizationURL(config, session.transaction));
		}
		if (!session.ownerVerified) return plain('Owner sign-in required.', 403);
		session.busy = true;
		try {
			if (url.pathname === '/check-a' && session.a && !session.b) session.after = await introspect(session.a);
			else if (url.pathname === '/check-both' && session.a && session.b) await checkBoth(session);
			else return plain('Complete the preceding test step first.', 409);
		} finally { session.busy = false; }
		return redirect('/');
	}
	return { handle, close() { clearInterval(timer); sessions.clear(); } };
}
