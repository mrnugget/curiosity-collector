import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { authEnabled, isAuthenticated, isPasswordValid, setSessionCookie } from '$lib/server/auth';

function safeNext(raw: string | null): string {
	// Only allow same-origin relative paths.
	return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export const load: PageServerLoad = ({ cookies, url }) => {
	if (!authEnabled() || isAuthenticated(cookies)) redirect(303, safeNext(url.searchParams.get('next')));
	return { next: safeNext(url.searchParams.get('next')) };
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const next = safeNext(String(form.get('next') ?? '/'));
		if (!isPasswordValid(password)) return fail(401, { wrong: true, next });
		setSessionCookie(cookies);
		redirect(303, next);
	}
};
