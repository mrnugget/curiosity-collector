import { error, json, type RequestHandler } from '@sveltejs/kit';
import { countDone, createItem, listItems } from '$lib/server/db';
import { fetchInBackground } from '$lib/server/metadata';
import { isBucket } from '$lib/types';

export const GET: RequestHandler = ({ url }) => {
	const done = url.searchParams.get('done') === '1';
	return json({ items: listItems({ done }), doneCount: countDone() });
};

export const POST: RequestHandler = async ({ request }) => {
	const data = (await request.json().catch(() => null)) as { body?: unknown; bucket?: unknown } | null;
	const body = typeof data?.body === 'string' ? data.body.trim() : '';
	if (!body) error(400, 'body is required');
	const bucket = isBucket(data?.bucket) ? data.bucket : 'inbox';
	const { item, toFetch } = createItem(body, bucket);
	fetchInBackground(toFetch);
	return json({ item }, { status: 201 });
};
