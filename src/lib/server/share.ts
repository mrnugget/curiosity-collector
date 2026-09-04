import { extractUrls } from '$lib/urls';

export interface Shared {
	title: string;
	text: string;
	url: string;
}

/** Android often puts the URL in `text` and leaves `url` empty; normalize that. */
export function composeBody({ title, text, url }: Shared): string {
	const parts: string[] = [];
	if (text) parts.push(text);
	if (url && !text.includes(url)) parts.push(url);
	if (parts.length === 0 && title) parts.push(title);
	// A shared page title is only worth keeping when there's no URL we can fetch it from.
	if (title && parts.length > 0 && extractUrls(parts.join('\n')).length === 0 && !text.includes(title)) {
		parts.unshift(title);
	}
	return parts.join('\n').trim();
}

