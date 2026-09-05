// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	interface Window {
		__ampJellyware?: { setEnabled(enabled: boolean): void };
	}
	namespace App {
		// interface Error {}
		interface Locals {
			user: import('$lib/server/auth').AuthedUser | null;
			accessToken: string | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
