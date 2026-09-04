import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Single-user auth: one shared password from COLLECTOR_PASSWORD. The session
 * cookie holds an HMAC derived from the password, so changing the password
 * logs every device out. No password means no auth (local dev).
 */

export const SESSION_COOKIE = 'cc_session';
const ONE_YEAR = 60 * 60 * 24 * 365;

export function authEnabled(): boolean {
	return Boolean(env.COLLECTOR_PASSWORD);
}

function sessionToken(): string {
	return createHmac('sha256', env.COLLECTOR_PASSWORD!).update('curiosity-collector-session').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function isPasswordValid(password: string): boolean {
	return authEnabled() && safeEqual(password, env.COLLECTOR_PASSWORD!);
}

export function isAuthenticated(cookies: Cookies): boolean {
	if (!authEnabled()) return true;
	const cookie = cookies.get(SESSION_COOKIE);
	return Boolean(cookie) && safeEqual(cookie!, sessionToken());
}

/** For scripts and iOS Shortcuts: `Authorization: Bearer <password>` or `?key=<password>`. */
export function isBearerAuthenticated(request: Request, url: URL): boolean {
	if (!authEnabled()) return true;
	const header = request.headers.get('authorization') ?? '';
	const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
	const key = bearer || url.searchParams.get('key') || '';
	return Boolean(key) && isPasswordValid(key);
}

export function setSessionCookie(cookies: Cookies): void {
	cookies.set(SESSION_COOKIE, sessionToken(), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: ONE_YEAR
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}
