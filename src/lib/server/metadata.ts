import { markLinkError, markLinkOk, pendingLinks, type Metadata, type NewLink } from './db';
import { isX, isYouTube } from '$lib/urls';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 curiosity-collector/1.0';

/** Fetch metadata for the given links in the background and store the results. */
export function fetchInBackground(links: NewLink[]): void {
	for (const link of links) {
		void fetchMetadata(link.cleanUrl)
			.then((meta) => markLinkOk(link.id, meta))
			.catch((err: unknown) => markLinkError(link.id, err instanceof Error ? err.message : String(err)));
	}
}

/** Called once at startup so links left pending by a crash/restart still get resolved. */
export function resumePendingFetches(): void {
	fetchInBackground(pendingLinks());
}

export async function fetchMetadata(url: string): Promise<Metadata> {
	const host = new URL(url).hostname.replace(/^www\./, '');
	if (isYouTube(host)) return fetchOEmbed(url, 'https://www.youtube.com/oembed', 'YouTube');
	if (isX(host) && /\/status\/\d+/.test(url)) return fetchTweet(url);
	return fetchHtmlMetadata(url);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
			redirect: 'follow',
			headers: {
				'user-agent': USER_AGENT,
				accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
				'accept-language': 'en-US,en;q=0.9,de;q=0.8',
				...(init.headers ?? {})
			}
		});
	} finally {
		clearTimeout(timer);
	}
}

async function fetchOEmbed(url: string, endpoint: string, siteName: string): Promise<Metadata> {
	const res = await fetchWithTimeout(`${endpoint}?url=${encodeURIComponent(url)}&format=json`);
	if (!res.ok) throw new Error(`oEmbed ${res.status}`);
	const data = (await res.json()) as { title?: string; author_name?: string };
	return {
		finalUrl: null,
		title: data.title?.trim() || null,
		description: data.author_name ? `by ${data.author_name}` : null,
		siteName
	};
}

async function fetchTweet(url: string): Promise<Metadata> {
	const res = await fetchWithTimeout(
		`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true&dnt=true`
	);
	if (!res.ok) throw new Error(`oEmbed ${res.status}`);
	const data = (await res.json()) as { author_name?: string; author_url?: string; html?: string };
	const text = data.html ? tweetText(data.html) : null;
	return {
		finalUrl: null,
		title: data.author_name ? `${data.author_name} on X` : null,
		description: text,
		siteName: 'X'
	};
}

/** The oEmbed HTML is a blockquote with the tweet's <p> followed by an attribution line. */
function tweetText(html: string): string | null {
	const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html);
	const raw = p ? p[1] : html;
	const text = decodeEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
	return text || null;
}

async function fetchHtmlMetadata(url: string): Promise<Metadata> {
	const res = await fetchWithTimeout(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const contentType = res.headers.get('content-type') ?? '';
	if (!/html|xml/i.test(contentType) && contentType !== '') {
		// Not a page: a PDF, image, etc. Use the filename as title.
		return {
			finalUrl: res.url !== url ? res.url : null,
			title: decodeURIComponent(new URL(res.url).pathname.split('/').pop() || '') || null,
			description: contentType.split(';')[0],
			siteName: null
		};
	}
	const html = await readPrefix(res, MAX_BYTES);
	const meta = parseHtmlMetadata(html);
	return { ...meta, finalUrl: res.url !== url ? res.url : null };
}

async function readPrefix(res: Response, maxBytes: number): Promise<string> {
	if (!res.body) return '';
	const reader = res.body.getReader();
	const decoder = new TextDecoder(detectCharset(res.headers.get('content-type')), { fatal: false });
	let out = '';
	let received = 0;
	while (received < maxBytes) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		out += decoder.decode(value, { stream: true });
		// Everything we care about lives in <head>; stop early once it's closed.
		if (/<\/head>/i.test(out)) break;
	}
	void reader.cancel().catch(() => {});
	return out;
}

function detectCharset(contentType: string | null): string {
	const m = /charset=([\w-]+)/i.exec(contentType ?? '');
	if (!m) return 'utf-8';
	try {
		new TextDecoder(m[1]);
		return m[1];
	} catch {
		return 'utf-8';
	}
}

export function parseHtmlMetadata(html: string): Omit<Metadata, 'finalUrl'> {
	const metas = new Map<string, string>();
	for (const tag of html.matchAll(/<meta\s[^>]*>/gi)) {
		const attrs = parseAttrs(tag[0]);
		const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase();
		const content = attrs.get('content');
		if (key && content !== undefined && !metas.has(key)) metas.set(key, decodeEntities(content).trim());
	}
	const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title =
		metas.get('og:title') || metas.get('twitter:title') || (titleTag ? decodeEntities(titleTag[1]) : '');
	const description =
		metas.get('og:description') || metas.get('twitter:description') || metas.get('description') || '';
	const siteName = metas.get('og:site_name') || '';
	return {
		title: squish(title) || null,
		description: squish(description) || null,
		siteName: squish(siteName) || null
	};
}

function parseAttrs(tag: string): Map<string, string> {
	const attrs = new Map<string, string>();
	for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
		attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
	}
	return attrs;
}

function squish(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	laquo: '«',
	raquo: '»',
	copy: '©',
	reg: '®',
	trade: '™',
	middot: '·',
	bull: '•',
	auml: 'ä',
	ouml: 'ö',
	uuml: 'ü',
	Auml: 'Ä',
	Ouml: 'Ö',
	Uuml: 'Ü',
	szlig: 'ß',
	eacute: 'é',
	egrave: 'è',
	agrave: 'à',
	ccedil: 'ç'
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ent: string) => {
		if (ent[0] === '#') {
			const code = ent[1].toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED_ENTITIES[ent] ?? whole;
	});
}
