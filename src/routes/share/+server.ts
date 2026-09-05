import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { canAccessCollector, isBearerAuthenticated } from '$lib/server/auth';
import { LOCAL_AUTH_DISABLED } from '$lib/server/config';
import { createItem } from '$lib/server/db';
import { fetchInBackground } from '$lib/server/metadata';
import { composeBody, type Shared } from '$lib/server/share';

/**
 * Web Share Target (see static/manifest.webmanifest) and a plain HTTP endpoint
 * for iOS Shortcuts / bookmarklets. Accepts `title`, `text`, `url` as form
 * fields (POST) or query parameters (GET).
 */

function pick(get: (k: string) => string | null): Shared {
	return {
		title: (get('title') ?? '').trim(),
		text: (get('text') ?? '').trim(),
		url: (get('url') ?? '').trim()
	};
}

function handleShared(shared: Shared, wantsJson: boolean): Response {
	const body = composeBody(shared);
	if (!body) error(400, 'nothing to save');
	const { item, toFetch } = createItem(body);
	fetchInBackground(toFetch);
	if (wantsJson) return Response.json({ item }, { status: 201 });
	redirect(303, `/#item-${item.id}`);
}

function authorize(event: Parameters<RequestHandler>[0]): void {
	if (LOCAL_AUTH_DISABLED || canAccessCollector(event.locals.user) || isBearerAuthenticated(event.request)) return;
	if (event.locals.user) error(403, 'forbidden');
	if (event.request.method === 'GET' && !event.url.searchParams.has('key')) {
		redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}
	error(401, 'unauthorized');
}

export const POST: RequestHandler = async (event) => {
	authorize(event);
	const type = event.request.headers.get('content-type') ?? '';
	let shared: Shared;
	if (type.includes('application/json')) {
		const data = (await event.request.json().catch(() => ({}))) as Record<string, unknown>;
		shared = pick((k) => (typeof data[k] === 'string' ? (data[k] as string) : null));
	} else {
		const form = await event.request.formData();
		shared = pick((k) => {
			const v = form.get(k);
			return typeof v === 'string' ? v : null;
		});
	}
	const wantsJson = (event.request.headers.get('accept') ?? '').includes('application/json');
	return handleShared(shared, wantsJson);
};

export const GET: RequestHandler = (event) => {
	authorize(event);
	const shared = pick((k) => event.url.searchParams.get(k));
	const wantsJson = (event.request.headers.get('accept') ?? '').includes('application/json');
	return handleShared(shared, wantsJson);
};
