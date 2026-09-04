import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '$env/dynamic/private';
import { building } from '$app/environment';
import type { Bucket, Item, Link, LinkStatus } from '$lib/types';
import { cleanUrl, extractUrls } from '$lib/urls';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS items (
	id         INTEGER PRIMARY KEY,
	body       TEXT NOT NULL,
	bucket     TEXT NOT NULL DEFAULT 'inbox' CHECK (bucket IN ('inbox', 'intro', 'later')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	done_at    TEXT
);

CREATE TABLE IF NOT EXISTS links (
	id          INTEGER PRIMARY KEY,
	item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	url         TEXT NOT NULL,
	clean_url   TEXT NOT NULL,
	final_url   TEXT,
	title       TEXT,
	description TEXT,
	site_name   TEXT,
	status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'error')),
	error       TEXT,
	fetched_at  TEXT,
	UNIQUE (item_id, url)
);

CREATE INDEX IF NOT EXISTS items_done_created ON items (done_at, created_at);
CREATE INDEX IF NOT EXISTS links_item ON links (item_id);
CREATE INDEX IF NOT EXISTS links_clean_url ON links (clean_url);
`;

function open(): DatabaseSync {
	// During `vite build` SvelteKit imports server modules to analyze them; don't touch disk then.
	const path = building ? ':memory:' : env.DATABASE_PATH || 'data/collector.db';
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);
	return db;
}

const db = open();

// ---------- row mapping ----------

interface ItemRow {
	id: number;
	body: string;
	bucket: Bucket;
	created_at: string;
	updated_at: string;
	done_at: string | null;
}

interface LinkRow {
	id: number;
	item_id: number;
	url: string;
	clean_url: string;
	final_url: string | null;
	title: string | null;
	description: string | null;
	site_name: string | null;
	status: LinkStatus;
	error: string | null;
}

function toLink(row: LinkRow): Link {
	return {
		id: row.id,
		url: row.url,
		cleanUrl: row.clean_url,
		finalUrl: row.final_url,
		title: row.title,
		description: row.description,
		siteName: row.site_name,
		status: row.status,
		error: row.error
	};
}

function toItem(row: ItemRow, links: Link[]): Item {
	return {
		id: row.id,
		body: row.body,
		bucket: row.bucket,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		doneAt: row.done_at,
		links
	};
}

// ---------- statements ----------

const stmts = {
	listOpen: db.prepare(`SELECT * FROM items WHERE done_at IS NULL ORDER BY created_at DESC, id DESC`),
	listDone: db.prepare(`SELECT * FROM items WHERE done_at IS NOT NULL ORDER BY done_at DESC, id DESC`),
	getItem: db.prepare(`SELECT * FROM items WHERE id = ?`),
	insertItem: db.prepare(`INSERT INTO items (body, bucket) VALUES (?, ?) RETURNING *`),
	updateBody: db.prepare(
		`UPDATE items SET body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	),
	updateBucket: db.prepare(
		`UPDATE items SET bucket = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	),
	setDone: db.prepare(
		`UPDATE items SET done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	),
	setUndone: db.prepare(
		`UPDATE items SET done_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	),
	deleteItem: db.prepare(`DELETE FROM items WHERE id = ?`),
	countDone: db.prepare(`SELECT count(*) AS n FROM items WHERE done_at IS NOT NULL`),

	linksForItems: db.prepare(`SELECT * FROM links WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY id`),
	linksForItem: db.prepare(`SELECT * FROM links WHERE item_id = ? ORDER BY id`),
	insertLink: db.prepare(`INSERT INTO links (item_id, url, clean_url) VALUES (?, ?, ?) RETURNING *`),
	deleteLinksNotIn: db.prepare(
		`DELETE FROM links WHERE item_id = ? AND url NOT IN (SELECT value FROM json_each(?))`
	),
	cachedMetadata: db.prepare(
		`SELECT final_url, title, description, site_name FROM links WHERE clean_url = ? AND status = 'ok' ORDER BY fetched_at DESC LIMIT 1`
	),
	markOk: db.prepare(
		`UPDATE links SET final_url = ?, title = ?, description = ?, site_name = ?, status = 'ok', error = NULL, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	),
	markError: db.prepare(
		`UPDATE links SET status = 'error', error = ?, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	),
	pendingLinks: db.prepare(`SELECT * FROM links WHERE status = 'pending' ORDER BY id`)
};

function attachLinks(rows: ItemRow[]): Item[] {
	if (rows.length === 0) return [];
	const ids = JSON.stringify(rows.map((r) => r.id));
	const linkRows = stmts.linksForItems.all(ids) as unknown as LinkRow[];
	const byItem = new Map<number, Link[]>();
	for (const row of linkRows) {
		const list = byItem.get(row.item_id) ?? [];
		list.push(toLink(row));
		byItem.set(row.item_id, list);
	}
	return rows.map((row) => toItem(row, byItem.get(row.id) ?? []));
}

// ---------- public API ----------

export function listItems(opts: { done?: boolean } = {}): Item[] {
	const rows = (opts.done ? stmts.listDone : stmts.listOpen).all() as unknown as ItemRow[];
	return attachLinks(rows);
}

export function countDone(): number {
	return (stmts.countDone.get() as { n: number }).n;
}

export function getItem(id: number): Item | null {
	const row = stmts.getItem.get(id) as unknown as ItemRow | undefined;
	if (!row) return null;
	return attachLinks([row])[0];
}

export interface NewLink {
	id: number;
	url: string;
	cleanUrl: string;
}

/**
 * Creates an item and its link rows. Returns the item plus the links that still
 * need metadata (already-known URLs get their metadata copied immediately).
 */
export function createItem(body: string, bucket: Bucket = 'inbox'): { item: Item; toFetch: NewLink[] } {
	const row = stmts.insertItem.get(body, bucket) as unknown as ItemRow;
	const toFetch = syncLinks(row.id, body);
	return { item: getItem(row.id)!, toFetch };
}

export function updateItem(
	id: number,
	patch: { body?: string; bucket?: Bucket; done?: boolean }
): { item: Item; toFetch: NewLink[] } | null {
	if (!stmts.getItem.get(id)) return null;
	let toFetch: NewLink[] = [];
	if (patch.body !== undefined) {
		stmts.updateBody.run(patch.body, id);
		toFetch = syncLinks(id, patch.body);
	}
	if (patch.bucket !== undefined) stmts.updateBucket.run(patch.bucket, id);
	if (patch.done === true) stmts.setDone.run(id);
	if (patch.done === false) stmts.setUndone.run(id);
	return { item: getItem(id)!, toFetch };
}

export function deleteItem(id: number): boolean {
	return stmts.deleteItem.run(id).changes > 0;
}

/** Make the links table match the URLs in `body`. Returns links needing a fetch. */
function syncLinks(itemId: number, body: string): NewLink[] {
	const urls = extractUrls(body);
	stmts.deleteLinksNotIn.run(itemId, JSON.stringify(urls));
	const existing = new Set(
		(stmts.linksForItem.all(itemId) as unknown as LinkRow[]).map((l) => l.url)
	);
	const toFetch: NewLink[] = [];
	for (const url of urls) {
		if (existing.has(url)) continue;
		const clean = cleanUrl(url);
		const row = stmts.insertLink.get(itemId, url, clean) as unknown as LinkRow;
		const cached = stmts.cachedMetadata.get(clean) as
			| { final_url: string | null; title: string | null; description: string | null; site_name: string | null }
			| undefined;
		if (cached) {
			stmts.markOk.run(cached.final_url, cached.title, cached.description, cached.site_name, row.id);
		} else {
			toFetch.push({ id: row.id, url, cleanUrl: clean });
		}
	}
	return toFetch;
}

export interface Metadata {
	finalUrl: string | null;
	title: string | null;
	description: string | null;
	siteName: string | null;
}

export function markLinkOk(linkId: number, meta: Metadata): void {
	stmts.markOk.run(meta.finalUrl, meta.title, meta.description, meta.siteName, linkId);
}

export function markLinkError(linkId: number, error: string): void {
	stmts.markError.run(error.slice(0, 500), linkId);
}

export function pendingLinks(): NewLink[] {
	return (stmts.pendingLinks.all() as unknown as LinkRow[]).map((l) => ({
		id: l.id,
		url: l.url,
		cleanUrl: l.clean_url
	}));
}
