import type { RequestHandler } from '@sveltejs/kit';
import { getOAuthConfig } from '$lib/server/config';
import { createHarness } from '$lib/server/oauth-lifecycle';

// Temporary, process-local diagnostic. Never uses or refreshes the normal app session.
let harness: ReturnType<typeof createHarness> | undefined;
const STEPS = new Set(['', 'auth/callback', 'signin-a', 'signin-b', 'check-a', 'check-both', 'reset']);
const safeHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-amp-review-widget': 'off' };

const handle: RequestHandler = async ({ request, params }) => {
	if (!STEPS.has(params.step ?? '')) return new Response('Not found.', { status: 404, headers: safeHeaders });
	try {
		// Origin comes only from the existing configured callback, never Host/forwarded headers.
		const config = getOAuthConfig();
		const origin = new URL(config.redirectURI).origin;
		if (new URL(request.url).origin !== origin || (request.method === 'POST' && request.headers.get('origin') !== origin)) {
			return new Response('Invalid request origin.', { status: 403, headers: safeHeaders });
		}
		// All controls are bodyless forms; reject even one unexpected body byte.
		if (request.body) {
			const reader = request.body.getReader();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('body_timeout')), 5000); })
				]);
				if (!chunk.done) return new Response('Body not accepted.', { status: 400, headers: safeHeaders });
			} finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
		}
		harness ??= createHarness({ origin, clientID: config.clientID, clientSecret: config.clientSecret });
		return await harness.handle(request);
	} catch {
		return new Response('Test unavailable.', { status: 503, headers: safeHeaders });
	}
};

export const GET = handle;
export const POST = handle;
