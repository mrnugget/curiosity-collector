/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

/**
 * Minimal service worker: makes the app installable (and therefore a share
 * target) and serves the immutable build assets from cache. Pages and API
 * calls always go to the network so data is never stale; if the network is
 * down, the last cached page shell is shown instead of a browser error.
 */

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `cache-${version}`;
const ASSETS = [...build, ...files];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== location.origin) return;

	if (ASSETS.includes(url.pathname)) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
		return;
	}

	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request)
				.then((res) => {
					if (res.ok && url.pathname === '/') {
						const copy = res.clone();
						caches.open(CACHE).then((cache) => cache.put('/', copy));
					}
					return res;
				})
				.catch(async () => (await caches.match('/')) ?? Response.error())
		);
	}
});
