<script lang="ts">
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Sign in — Joy & Curiosity</title></svelte:head>

<div class="window login">
	<div class="titlebar"><span class="title">Joy & Curiosity</span></div>
	<div class="body">
		{#if data.user}
			<p>Signed in as {data.user.displayName}.</p>
			{#if data.allowed}
				<a href={data.next}>Open collector</a>
			{:else}
				<p class="error">This account is not allowed to access this collector.</p>
				<p>Amp user ID: <code>{data.user.id}</code></p>
			{/if}
			<form method="POST" action="/auth/signout"><button class="btn">Sign out</button></form>
		{:else}
			<p>Sign in with your Amp account to open your collector.</p>
			{#if data.failed}<p class="error">Sign-in failed. Please try again.</p>{/if}
			{#if data.configured}
				<a class="btn" href={`/auth/signin?returnTo=${encodeURIComponent(data.next)}`}>Sign in with Amp</a>
			{:else}
				<p class="error">Amp sign-in is not configured. Ask the app administrator to finish setup.</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.login { width: min(24rem, calc(100vw - 2rem)); margin: 20vh auto 0; }
	.body { display: grid; gap: 1rem; padding: 1rem; }
	p { margin: 0; }
	.error { color: var(--danger); }
	.btn { justify-self: start; }
</style>
