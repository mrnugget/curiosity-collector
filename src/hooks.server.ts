import { error, json, redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { authenticateSession, canAccessCollector, AUTH_COOKIE, SESSION_MAX_AGE_SECONDS } from '$lib/server/auth';
import { LOCAL_AUTH_DISABLED, SECURE_COOKIES } from '$lib/server/config';
import { resumePendingFetches } from '$lib/server/metadata';

export const init: ServerInit = () => {
	if (!building) resumePendingFetches();
};

/** Paths reachable without a session cookie. */
const PUBLIC = new Set(['/login', '/auth/signin', '/auth/callback', '/auth/signout', '/manifest.webmanifest', '/service-worker.js']);

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;
	event.locals.user = null;
	event.locals.accessToken = null;
	try {
		const session = await authenticateSession(event.cookies.get(AUTH_COOKIE));
		if (session) {
			event.locals.user = session.user;
			event.locals.accessToken = session.accessToken;
			if (session.refreshedCookie) event.cookies.set(AUTH_COOKIE, session.refreshedCookie, {
				path: '/', httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES, maxAge: SESSION_MAX_AGE_SECONDS
			});
		} else if (event.cookies.get(AUTH_COOKIE)) {
			event.cookies.delete(AUTH_COOKIE, { path: '/', secure: SECURE_COOKIES });
		}
	} catch {
		// Failed refresh must never grant access or expose provider credentials.
		event.locals.user = null;
		event.locals.accessToken = null;
		event.cookies.delete(AUTH_COOKIE, { path: '/', secure: SECURE_COOKIES });
	}
	const isPublic =
		PUBLIC.has(pathname) ||
		pathname.startsWith('/icons/') ||
		pathname.startsWith('/_app/') ||
		pathname === '/favicon.svg' ||
		pathname === '/robots.txt' ||
		// Jellyware requires its own OAuth session; notes permissions are not launch permissions.
		pathname === '/api/jellyware' ||
		// /share does its own auth so Shortcuts can call it with a bearer token.
		pathname === '/share';

	if (!isPublic && !LOCAL_AUTH_DISABLED && !event.locals.user) {
		if (pathname.startsWith('/api/')) return json({ error: 'unauthorized' }, { status: 401 });
		redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
	}
	if (!isPublic && !LOCAL_AUTH_DISABLED && !canAccessCollector(event.locals.user)) {
		if (pathname.startsWith('/api/')) return json({ error: 'forbidden' }, { status: 403 });
		error(403, 'This Amp account is not allowed to access this collector. Visit /login to sign out.');
	}

	const response = await resolve(event);
	if (!pathname.startsWith('/_app/') && !pathname.startsWith('/icons/')) {
		response.headers.set('cache-control', 'private, no-store');
	}
	return response;
};
