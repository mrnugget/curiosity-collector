import { json, redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { isAuthenticated } from '$lib/server/auth';
import { resumePendingFetches } from '$lib/server/metadata';

export const init: ServerInit = () => {
	if (!building) resumePendingFetches();
};

/** Paths reachable without a session cookie. */
const PUBLIC = new Set(['/login', '/manifest.webmanifest', '/service-worker.js']);

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;
	const isPublic =
		PUBLIC.has(pathname) ||
		pathname.startsWith('/icons/') ||
		pathname.startsWith('/_app/') ||
		pathname === '/favicon.svg' ||
		pathname === '/robots.txt' ||
		// /share does its own auth so Shortcuts can call it with a bearer token.
		pathname === '/share';

	if (!isPublic && !isAuthenticated(event.cookies)) {
		if (pathname.startsWith('/api/')) return json({ error: 'unauthorized' }, { status: 401 });
		redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
	}

	return resolve(event);
};
