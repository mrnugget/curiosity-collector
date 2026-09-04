/** Compact relative time: "now", "5m", "3h", "2d", then a short date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
	const then = new Date(iso).getTime();
	const s = Math.max(0, Math.round((now - then) / 1000));
	if (s < 60) return 'now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.round(h / 24);
	if (d < 14) return `${d}d`;
	return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
