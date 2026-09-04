export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Older WebViews / non-secure contexts: fall back to a hidden textarea.
		const el = document.createElement('textarea');
		el.value = text;
		el.setAttribute('readonly', '');
		el.style.position = 'fixed';
		el.style.opacity = '0';
		document.body.append(el);
		el.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} finally {
			el.remove();
		}
		return ok;
	}
}
