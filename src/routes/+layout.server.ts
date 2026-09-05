import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.accessToken) return { widget: null };
	try {
		// Notes access and platform app management are separate permissions.
		const response = await fetch('https://ampcode.com/api/jellyware/context?app=amp/curiosity-collector', {
			headers: { Authorization: `Bearer ${locals.accessToken}` },
			redirect: 'error',
			signal: AbortSignal.timeout(3000)
		});
		if (!response.ok) return { widget: null };
		const { widget } = await response.json();
		if (widget && typeof widget.scriptURL === 'string' && typeof widget.appID === 'string' &&
			widget.scriptURL === 'https://ampcode.com/jellyware/widget.js') {
			return { widget: { scriptURL: widget.scriptURL, appID: widget.appID } };
		}
	} catch {
		// A platform outage must not prevent access to notes.
	}
	return { widget: null };
};
