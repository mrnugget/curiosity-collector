import type { LayoutServerLoad } from './$types';
import { AMP_BOX, AMP_BOX_DEPLOYMENT } from '$lib/server/config';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.accessToken || !AMP_BOX) return { widget: null };
	try {
		// Notes access and Box access are separate permissions: Amp decides who sees the widget.
		const url = new URL('https://ampcode.com/api/jellyware/context');
		url.searchParams.set('box', AMP_BOX);
		if (AMP_BOX_DEPLOYMENT) url.searchParams.set('deployment', AMP_BOX_DEPLOYMENT);
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${locals.accessToken}` },
			redirect: 'error',
			signal: AbortSignal.timeout(3000)
		});
		if (!response.ok) return { widget: null };
		const { widget } = await response.json();
		if (widget && typeof widget.machineID === 'string' && widget.machineID.length > 0 && widget.machineID.length <= 256 &&
			widget.scriptURL === 'https://ampcode.com/jellyware/widget.js') {
			return { widget: { scriptURL: widget.scriptURL as string, machineID: widget.machineID as string } };
		}
	} catch {
		// A platform outage must not prevent access to notes.
	}
	return { widget: null };
};
