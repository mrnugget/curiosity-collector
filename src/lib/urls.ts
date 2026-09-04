/**
 * URL helpers shared by server and client.
 */

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?'"”’)\]}]+$/;

/** Find all URLs in a piece of freeform text, in order, without duplicates. */
export function extractUrls(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of text.matchAll(URL_RE)) {
		const url = trimUrl(match[0]);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

/**
 * Split text into plain and URL segments so the client can render links
 * without touching innerHTML.
 */
export function segmentText(text: string): Array<{ type: 'text' | 'url'; value: string }> {
	const segments: Array<{ type: 'text' | 'url'; value: string }> = [];
	let last = 0;
	for (const match of text.matchAll(URL_RE)) {
		const start = match.index;
		const url = trimUrl(match[0]);
		if (start > last) segments.push({ type: 'text', value: text.slice(last, start) });
		segments.push({ type: 'url', value: url });
		last = start + url.length;
	}
	if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
	return segments;
}

function trimUrl(raw: string): string {
	let url = raw.replace(TRAILING_PUNCTUATION, '');
	// Keep a trailing ")" if it closes a "(" inside the URL (Wikipedia-style).
	const trimmedParen = raw.length > url.length && raw[url.length] === ')';
	if (trimmedParen && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) {
		url += ')';
	}
	return url;
}

const GLOBAL_TRACKING_PARAMS = new Set([
	'fbclid',
	'gclid',
	'dclid',
	'msclkid',
	'mc_cid',
	'mc_eid',
	'igshid',
	'igsh',
	'ref_src',
	'ref_url',
	'_hsenc',
	'_hsmi',
	'vero_id',
	'yclid',
	'oly_anon_id',
	'oly_enc_id',
	'wickedid',
	'twclid',
	'ttclid',
	'srsltid'
]);

/** Remove tracking parameters. Returns the input unchanged if it can't be parsed. */
export function cleanUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return input;
	}
	const host = url.hostname.replace(/^www\./, '');
	const params = url.searchParams;
	const toDelete: string[] = [];
	for (const key of params.keys()) {
		if (key.startsWith('utm_') || GLOBAL_TRACKING_PARAMS.has(key)) toDelete.push(key);
		else if (isYouTube(host) && key === 'si') toDelete.push(key);
		else if (isX(host) && (key === 's' || key === 't')) toDelete.push(key);
		else if (host.endsWith('substack.com') && key === 'r') toDelete.push(key);
	}
	for (const key of toDelete) params.delete(key);
	let out = url.toString();
	if (out.endsWith('?')) out = out.slice(0, -1);
	return out;
}

export function isYouTube(host: string): boolean {
	return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
}

export function isX(host: string): boolean {
	return host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com');
}

/** "nolanlawson.com" from a URL, for compact display. */
export function hostOf(input: string): string {
	try {
		return new URL(input).hostname.replace(/^www\./, '');
	} catch {
		return input;
	}
}
