import { error, json, type RequestHandler } from '@sveltejs/kit';
import { deleteItem, updateItem } from '$lib/server/db';
import { fetchInBackground } from '$lib/server/metadata';
import { isBucket, type Bucket } from '$lib/types';

function parseId(raw: string): number {
	const id = Number(raw);
	if (!Number.isInteger(id) || id <= 0) error(404, 'not found');
	return id;
}

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = parseId(params.id!);
	const data = (await request.json().catch(() => null)) as
		| { body?: unknown; bucket?: unknown; done?: unknown }
		| null;
	if (!data) error(400, 'invalid json');

	const patch: { body?: string; bucket?: Bucket; done?: boolean } = {};
	if (typeof data.body === 'string') {
		const body = data.body.trim();
		if (!body) error(400, 'body must not be empty');
		patch.body = body;
	}
	if (data.bucket !== undefined) {
		if (!isBucket(data.bucket)) error(400, 'invalid bucket');
		patch.bucket = data.bucket;
	}
	if (typeof data.done === 'boolean') patch.done = data.done;

	const result = updateItem(id, patch);
	if (!result) error(404, 'not found');
	fetchInBackground(result.toFetch);
	return json({ item: result.item });
};

export const DELETE: RequestHandler = ({ params }) => {
	const id = parseId(params.id!);
	if (!deleteItem(id)) error(404, 'not found');
	return new Response(null, { status: 204 });
};
