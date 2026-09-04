import type { Bucket, Item } from '$lib/types';

export interface ItemPatch {
	body?: string;
	bucket?: Bucket;
	done?: boolean;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, {
		...init,
		headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) }
	});
	if (res.status === 401) {
		location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
		throw new Error('unauthorized');
	}
	if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status}`);
	return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export function fetchItems(done = false): Promise<{ items: Item[]; doneCount: number }> {
	return request(`/api/items${done ? '?done=1' : ''}`);
}

export async function createItem(body: string, bucket: Bucket = 'inbox'): Promise<Item> {
	const { item } = await request<{ item: Item }>('/api/items', {
		method: 'POST',
		body: JSON.stringify({ body, bucket })
	});
	return item;
}

export async function patchItem(id: number, patch: ItemPatch): Promise<Item> {
	const { item } = await request<{ item: Item }>(`/api/items/${id}`, {
		method: 'PATCH',
		body: JSON.stringify(patch)
	});
	return item;
}

export function deleteItem(id: number): Promise<void> {
	return request(`/api/items/${id}`, { method: 'DELETE' });
}
