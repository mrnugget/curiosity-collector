export const BUCKETS = ['inbox', 'intro', 'later'] as const;
export type Bucket = (typeof BUCKETS)[number];

export function isBucket(value: unknown): value is Bucket {
	return typeof value === 'string' && (BUCKETS as readonly string[]).includes(value);
}

export type LinkStatus = 'pending' | 'ok' | 'error';

export interface Link {
	id: number;
	/** The URL exactly as it appears in the note body. */
	url: string;
	/** URL with tracking parameters stripped. This is what gets copied. */
	cleanUrl: string;
	/** URL after following redirects, if different. */
	finalUrl: string | null;
	title: string | null;
	description: string | null;
	siteName: string | null;
	status: LinkStatus;
	error: string | null;
}

export interface Item {
	id: number;
	body: string;
	bucket: Bucket;
	createdAt: string;
	updatedAt: string;
	doneAt: string | null;
	links: Link[];
}
