import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canAccessCollector } from '$lib/server/auth';
import { LOCAL_AUTH_DISABLED, oauthConfigurationError } from '$lib/server/config';
import { normalizeReturnTo } from '$lib/server/oauth';

export const load: PageServerLoad = ({ locals, url }) => {
	const next = normalizeReturnTo(url.searchParams.get('next'), '/');
	if (LOCAL_AUTH_DISABLED) redirect(303, next);
	return {
		next,
		user: locals.user,
		allowed: canAccessCollector(locals.user),
		configured: oauthConfigurationError() === null,
		failed: url.searchParams.has('auth_error')
	};
};
