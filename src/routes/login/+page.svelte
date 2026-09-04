<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Log in — Joy & Curiosity</title>
</svelte:head>

<div class="window login">
	<div class="titlebar"><span class="title">Log in</span></div>
	<form method="POST" class="body">
		<input type="hidden" name="next" value={form?.next ?? data.next} />
		<label for="password">Password</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
		{#if form?.wrong}
			<p class="error">That's not it.</p>
		{/if}
		<button type="submit" class="btn">OK</button>
	</form>
</div>

<style>
	.login {
		width: min(20rem, calc(100vw - 2rem));
		margin: 20vh auto 0;
	}
	.body {
		display: grid;
		gap: 0.5rem;
		padding: 1rem;
	}
	label {
		font-size: 0.8rem;
		color: var(--muted);
	}
	input[type='password'] {
		font: inherit;
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--rule);
		background: var(--paper);
		color: var(--ink);
	}
	.error {
		margin: 0;
		font-size: 0.8rem;
		color: var(--danger);
	}
	.btn {
		justify-self: end;
		min-width: 5rem;
	}
</style>
