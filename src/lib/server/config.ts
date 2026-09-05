import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { OAuthConfig } from './oauth';

export const SESSION_SECRET = env.COLLECTOR_SESSION_SECRET?.trim() ?? '';
export const LOCAL_AUTH_DISABLED = dev && env.NODE_ENV !== 'production' && !env.AMP_OAUTH_CLIENT_ID;
export const SECURE_COOKIES = !env.AMP_OAUTH_REDIRECT_URI?.startsWith('http://');

export function oauthConfigurationError(): string | null {
	for (const name of ['AMP_OAUTH_CLIENT_ID', 'AMP_OAUTH_CLIENT_SECRET', 'AMP_OAUTH_REDIRECT_URI']) {
		if (!env[name]?.trim()) return `Missing ${name}`;
	}
	if (SESSION_SECRET.length < 32) return 'COLLECTOR_SESSION_SECRET must contain at least 32 characters';
	try {
		const uri = new URL(env.AMP_OAUTH_REDIRECT_URI!.trim());
		const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname);
		if (uri.pathname !== '/auth/callback' || uri.search || uri.hash || uri.username || uri.password ||
			(uri.protocol !== 'https:' && !(uri.protocol === 'http:' && loopback))) {
			return 'AMP_OAUTH_REDIRECT_URI must be an exact HTTPS /auth/callback URI (HTTP only on loopback)';
		}
	} catch {
		return 'AMP_OAUTH_REDIRECT_URI must be a valid URL';
	}
	return null;
}

export function getOAuthConfig(): OAuthConfig {
	const problem = oauthConfigurationError();
	if (problem) throw new Error(problem);
	return {
		issuer: 'https://auth.ampcode.com',
		authorizationURL: 'https://auth.ampcode.com/oauth2/authorize',
		tokenURL: 'https://auth.ampcode.com/oauth2/token',
		jwksURL: 'https://auth.ampcode.com/oauth2/jwks',
		resourceURL: 'https://ampcode.com/api/v2',
		clientID: env.AMP_OAUTH_CLIENT_ID!.trim(),
		clientSecret: env.AMP_OAUTH_CLIENT_SECRET!.trim(),
		redirectURI: env.AMP_OAUTH_REDIRECT_URI!.trim()
	};
}
