import { json, type RequestHandler } from '@sveltejs/kit';
import { getOAuthConfig } from '$lib/server/config';

const AMP_ORIGIN = 'https://ampcode.com';
const UPSTREAM = `${AMP_ORIGIN}/api/jellyware/launch?app=amp/curiosity-collector`;
const MAX_BYTES = 200_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Destination = 'orb' | 'obelisk';
type LaunchRequest =
	| { action: 'authorize'; destination: Destination }
	| { action: 'send'; destination: Destination; requestID: string; comments: unknown[] };

function reply(body: object, status = 200): Response {
	return json(body, { status, headers: { 'cache-control': 'private, no-store' } });
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length <= max;
}

function integer(value: unknown, max: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function comment(value: unknown): Record<string, unknown> | null {
	if (!record(value) || typeof value.comment !== 'string' || !value.comment.trim() ||
		value.comment.trim().length > 4000 || !text(value.page, 2000)) return null;
	const result: Record<string, unknown> = { comment: value.comment.trim(), page: value.page };
	if (value.target !== undefined) {
		const target = value.target;
		if (!record(target) || !text(target.selector, 500) || !text(target.snippet, 500)) return null;
		const clean: Record<string, unknown> = { selector: target.selector, snippet: target.snippet };
		if (target.source !== undefined) {
			if (!record(target.source)) return null;
			const source: Record<string, unknown> = {};
			for (const [key, max] of Object.entries({ framework: 50, file: 500, component: 200 })) {
				if (target.source[key] !== undefined) {
					if (!text(target.source[key], max)) return null;
					source[key] = target.source[key];
				}
			}
			for (const [key, max] of Object.entries({ line: 1_000_000, column: 100_000 })) {
				if (target.source[key] !== undefined) {
					if (!integer(target.source[key], max)) return null;
					source[key] = target.source[key];
				}
			}
			clean.source = source;
		}
		result.target = clean;
	}
	if (value.viewport !== undefined) {
		if (!record(value.viewport) || !integer(value.viewport.width, 100_000) || !integer(value.viewport.height, 100_000)) return null;
		result.viewport = { width: value.viewport.width, height: value.viewport.height };
	}
	return result;
}

async function readJSON(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
	if (!body) throw new SyntaxError('Missing body');
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_BYTES) {
				await reader.cancel();
				throw new RangeError('Body too large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function destinationState(value: unknown) {
	if (!record(value) || typeof value.available !== 'boolean' || typeof value.authorized !== 'boolean' ||
		(value.reason !== null && (typeof value.reason !== 'string' || value.reason.length > 1000))) return null;
	return { available: value.available, authorized: value.authorized, reason: value.reason };
}

function safeURL(value: unknown, action: LaunchRequest['action']): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		const path = action === 'authorize'
			? /^\/jellyware\/authorize\/[A-Za-z0-9_-]+$/
			: /^\/threads\/T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		return url.origin === AMP_ORIGIN && !url.username && !url.password && !url.search && !url.hash && path.test(url.pathname)
			? url.href : null;
	} catch {
		return null;
	}
}

async function relay(accessToken: string, payload?: LaunchRequest): Promise<Response> {
	try {
		const response = await fetch(UPSTREAM, {
			method: payload ? 'POST' : 'GET',
			headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
			body: payload ? JSON.stringify(payload) : undefined,
			redirect: 'error',
			cache: 'no-store',
			signal: AbortSignal.timeout(payload?.action === 'send' ? 60_000 : 30_000)
		});
		if (!response.ok) {
			await response.body?.cancel();
			const status = [400, 401, 403, 404, 409, 413, 422, 429, 503, 504].includes(response.status) ? response.status : 502;
			return reply({ error: 'Amp could not complete this request.' }, status);
		}
		const data = await readJSON(response.body);
		if (!record(data)) return reply({ error: 'Invalid response from Amp.' }, 502);
		if (payload) {
			const field = payload.action === 'authorize' ? 'authorizationURL' : 'threadURL';
			const url = safeURL(data[field], payload.action);
			return url ? reply({ [field]: url }) : reply({ error: 'Invalid response from Amp.' }, 502);
		}
		if (!record(data.destinations)) return reply({ error: 'Invalid response from Amp.' }, 502);
		const orb = destinationState(data.destinations.orb);
		const obelisk = destinationState(data.destinations.obelisk);
		if (!orb || !obelisk || typeof data.appID !== 'string' || !data.appID || data.appID.length > 256 ||
			typeof data.appName !== 'string' || !data.appName || data.appName.length > 256) {
			return reply({ error: 'Invalid response from Amp.' }, 502);
		}
		return reply({ appID: data.appID, appName: data.appName, destinations: { orb, obelisk } });
	} catch (cause) {
		const timeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
		return reply({ error: timeout ? 'Amp request timed out.' : 'Amp is unavailable.' }, timeout ? 504 : 502);
	}
}

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user || !locals.accessToken) return reply({ error: 'Sign in with Amp required.' }, 401);
	return relay(locals.accessToken);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user || !locals.accessToken) return reply({ error: 'Sign in with Amp required.' }, 401);
	if (request.headers.get('origin') !== new URL(getOAuthConfig().redirectURI).origin) {
		return reply({ error: 'Invalid request origin.' }, 403);
	}
	if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
		return reply({ error: 'JSON content type required.' }, 415);
	}
	if (Number(request.headers.get('content-length')) > MAX_BYTES) return reply({ error: 'Request too large.' }, 413);
	let data: unknown;
	try {
		data = await readJSON(request.body);
	} catch (cause) {
		return reply({ error: 'Invalid request body.' }, cause instanceof RangeError ? 413 : 400);
	}
	if (!record(data) || (data.destination !== 'orb' && data.destination !== 'obelisk')) return reply({ error: 'Invalid request.' }, 400);
	if (data.action === 'authorize' && Object.keys(data).every((key) => ['action', 'destination'].includes(key))) {
		return relay(locals.accessToken, { action: 'authorize', destination: data.destination });
	}
	if (data.action === 'send' && Object.keys(data).every((key) => ['action', 'destination', 'requestID', 'comments'].includes(key)) &&
		typeof data.requestID === 'string' && UUID.test(data.requestID) && Array.isArray(data.comments) && data.comments.length > 0 && data.comments.length <= 20) {
		const comments = data.comments.map(comment);
		if (comments.some((value) => value === null)) return reply({ error: 'Invalid comments.' }, 400);
		return relay(locals.accessToken, { action: 'send', destination: data.destination, requestID: data.requestID, comments });
	}
	return reply({ error: 'Invalid request.' }, 400);
};
