<script lang="ts">
	import type { PageProps } from './$types';
	import type { Bucket, Item } from '$lib/types';
	import { BUCKETS } from '$lib/types';
	import { cleanUrl, extractUrls } from '$lib/urls';
	import * as api from '$lib/client/api';
	import Note from '$lib/components/Note.svelte';

	let { data }: PageProps = $props();

	// Server-rendered data seeds local state; after that the client owns it.
	// svelte-ignore state_referenced_locally
	let items = $state<Item[]>(data.items);
	// svelte-ignore state_referenced_locally
	let doneCount = $state(data.doneCount);
	let doneItems = $state<Item[]>([]);
	let showDone = $state(false);

	let draft = $state('');
	let capture = $state<HTMLTextAreaElement | null>(null);
	let notice = $state<string | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;

	/** Mutations in flight; background refreshes wait so they can't revert optimistic state. */
	let inflight = 0;

	const SECTION_TITLES: Record<Bucket, string> = { inbox: 'Inbox', intro: 'Intro', later: 'Later' };
	const sections = $derived(
		BUCKETS.map((bucket) => ({ bucket, items: items.filter((i) => i.bucket === bucket) })).filter(
			(s) => s.bucket === 'inbox' || s.items.length > 0
		)
	);
	const hasPending = $derived(items.some((i) => i.links.some((l) => l.status === 'pending')));

	function say(message: string) {
		notice = message;
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (notice = null), 2500);
	}

	// ---------- data ----------

	async function refresh() {
		if (inflight > 0) return;
		try {
			const res = await api.fetchItems();
			if (inflight > 0) return;
			items = res.items;
			doneCount = res.doneCount;
			if (showDone) doneItems = (await api.fetchItems(true)).items;
		} catch {
			/* offline; try again on next trigger */
		}
	}

	async function mutate<T>(work: () => Promise<T>, rollback: () => void, failure: string): Promise<T | undefined> {
		inflight++;
		try {
			return await work();
		} catch {
			rollback();
			say(failure);
		} finally {
			inflight--;
		}
	}

	async function add() {
		const body = draft.trim();
		if (!body) return;
		draft = '';
		const now = new Date().toISOString();
		const temp: Item = {
			id: -Date.now(),
			body,
			bucket: 'inbox',
			createdAt: now,
			updatedAt: now,
			doneAt: null,
			links: extractUrls(body).map((url, i) => ({
				id: -i - 1,
				url,
				cleanUrl: cleanUrl(url),
				finalUrl: null,
				title: null,
				description: null,
				siteName: null,
				status: 'pending',
				error: null
			}))
		};
		items = [temp, ...items];
		capture?.focus();
		await mutate(
			async () => {
				const item = await api.createItem(body);
				items = items.map((i) => (i.id === temp.id ? item : i));
			},
			() => {
				items = items.filter((i) => i.id !== temp.id);
				draft = body;
			},
			"Couldn't save — are you offline?"
		);
	}

	async function patch(item: Item, p: api.ItemPatch) {
		const before = { items, doneItems, doneCount };
		if (p.done === true) {
			items = items.filter((i) => i.id !== item.id);
			doneCount++;
		} else if (p.done === false) {
			doneItems = doneItems.filter((i) => i.id !== item.id);
			doneCount--;
			items = [{ ...item, doneAt: null }, ...items];
		} else {
			items = items.map((i) => (i.id === item.id ? { ...i, ...p } : i));
		}
		await mutate(
			async () => {
				const updated = await api.patchItem(item.id, p);
				if (p.done === true) return;
				items = items.map((i) => (i.id === item.id ? updated : i));
			},
			() => ({ items, doneItems, doneCount } = before),
			"Couldn't save that change"
		);
	}

	async function remove(item: Item, fromDone: boolean) {
		if (fromDone && !confirm('Delete permanently?')) return;
		const before = { items, doneItems, doneCount };
		if (fromDone) {
			doneItems = doneItems.filter((i) => i.id !== item.id);
			doneCount--;
		} else {
			items = items.filter((i) => i.id !== item.id);
		}
		await mutate(
			() => api.deleteItem(item.id),
			() => ({ items, doneItems, doneCount } = before),
			"Couldn't delete"
		);
	}

	async function toggleDone() {
		showDone = !showDone;
		if (showDone) doneItems = (await api.fetchItems(true)).items;
	}

	// Poll while any link is still being fetched. Reading `items` makes this re-run after each refresh.
	$effect(() => {
		void items;
		if (!hasPending) return;
		const t = setTimeout(refresh, 1500);
		return () => clearTimeout(t);
	});

	// ---------- always ready to type ----------

	function isEditable(el: EventTarget | null): boolean {
		return (
			el instanceof HTMLElement &&
			(el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
		);
	}

	function focusCapture() {
		if (!capture) return;
		capture.focus();
		capture.setSelectionRange(capture.value.length, capture.value.length);
	}

	function onWindowPaste(e: ClipboardEvent) {
		if (isEditable(e.target)) return;
		const text = e.clipboardData?.getData('text/plain');
		if (!text) return;
		e.preventDefault();
		draft = draft ? `${draft}\n${text}` : text;
		focusCapture();
	}

	/** Typing anywhere on the page goes into the capture box. */
	function onWindowKeydown(e: KeyboardEvent) {
		if (isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
		const onControl = e.target instanceof HTMLElement && e.target.closest('button, a') !== null;
		if (onControl && (e.key === ' ' || e.key === 'Enter')) return; // let the control activate
		if (e.key.length === 1 || e.key === 'Enter') focusCapture();
	}

	function onVisibility() {
		if (document.visibilityState !== 'visible') return;
		refresh();
		if (!isEditable(document.activeElement) && matchMedia('(pointer: fine)').matches) focusCapture();
	}

	function onCaptureKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			add();
		}
	}

	$effect(() => {
		void draft;
		if (!capture) return;
		capture.style.height = 'auto';
		capture.style.height = `${capture.scrollHeight}px`;
	});
</script>

<svelte:head>
	<title>Joy & Curiosity</title>
</svelte:head>

<svelte:window onpaste={onWindowPaste} onkeydown={onWindowKeydown} onfocus={onVisibility} />
<svelte:document onvisibilitychange={onVisibility} />

<main class="window">
	<div class="titlebar">
		<span class="title">Joy &amp; Curiosity — Notepad</span>
		<span class="meta">{items.length} {items.length === 1 ? 'note' : 'notes'}</span>
	</div>

	<div class="page">
		<form class="capture" onsubmit={(e) => (e.preventDefault(), add())}>
			<span class="prompt" aria-hidden="true">&gt;</span>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea
				bind:this={capture}
				bind:value={draft}
				onkeydown={onCaptureKeydown}
				placeholder="Paste a link or type a thought…"
				aria-label="New note"
				rows="1"
				autofocus
				autocapitalize="sentences"
				spellcheck="false"
			></textarea>
			<button type="submit" class="btn add" disabled={!draft.trim()}>Add</button>
		</form>
		<p class="hint">
			{#if notice}
				<span class="notice">{notice}</span>
			{:else}
				Enter adds · Shift+Enter for a new line · click a note to edit it
			{/if}
		</p>

		{#each sections as section (section.bucket)}
			<section>
				<h2>
					{SECTION_TITLES[section.bucket]}
					<span class="count">{section.items.length}</span>
				</h2>
				{#if section.items.length === 0}
					<p class="empty">Nothing here yet.</p>
				{:else}
					{#each section.items as item (item.id)}
						<Note {item} onpatch={(p) => patch(item, p)} ondelete={() => remove(item, false)} />
					{/each}
				{/if}
			</section>
		{/each}

		<footer>
			{#if doneCount > 0}
				<button class="quiet" onclick={toggleDone}>
					{doneCount} done · {showDone ? 'hide' : 'show'}
				</button>
			{:else}
				<span class="faint">Nothing done yet.</span>
			{/if}
		</footer>

		{#if showDone}
			<section class="done-list">
				<h2>Done <span class="count">{doneItems.length}</span></h2>
				{#each doneItems as item (item.id)}
					<Note {item} archived onpatch={(p) => patch(item, p)} ondelete={() => remove(item, true)} />
				{/each}
			</section>
		{/if}
	</div>
</main>

<style>
	main {
		width: min(44rem, 100%);
		margin: 3vh auto 6vh;
	}
	.page {
		padding: 0.75rem 1.25rem 1.5rem;
	}

	.capture {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--rule);
		background: #fff;
		box-shadow: inset 1px 1px 0 var(--paper-dim);
	}
	.capture:focus-within {
		border-color: var(--chrome-dark);
	}
	.prompt {
		color: var(--faint);
		user-select: none;
		line-height: 1.5;
	}
	.capture textarea {
		flex: 1;
		min-width: 0;
		margin: 0;
		padding: 0;
		font: inherit;
		line-height: inherit;
		color: inherit;
		background: transparent;
		border: 0;
		outline: none;
		resize: none;
		overflow: hidden;
		min-height: 1.5em;
		max-height: 60vh;
	}
	.capture textarea::placeholder {
		color: var(--faint);
	}
	.add {
		flex: none;
		align-self: flex-end;
	}
	.add:disabled {
		color: var(--chrome-dark);
		text-shadow: 1px 1px 0 var(--chrome-light);
		cursor: default;
	}

	.hint {
		margin: 0.35rem 0 0;
		font-size: 12px;
		color: var(--faint);
		min-height: 1.5em;
	}
	.notice {
		color: var(--danger);
	}

	section {
		margin-top: 1.5rem;
	}
	h2 {
		margin: 0;
		padding-bottom: 0.25rem;
		font-family: var(--ui);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--muted);
		border-bottom: 1px solid var(--rule);
	}
	.count {
		margin-left: 0.4rem;
		font-weight: 400;
		color: var(--faint);
		letter-spacing: 0;
	}
	.empty {
		margin: 0.75rem 0 0;
		color: var(--faint);
	}

	footer {
		margin-top: 2rem;
		font-size: 12px;
		text-align: center;
	}
	.faint {
		color: var(--faint);
	}
	.done-list {
		opacity: 0.85;
	}

	@media (max-width: 640px) {
		main {
			margin: 0;
			min-height: 100dvh;
		}
		.titlebar {
			position: sticky;
			top: 0;
			z-index: 1;
			margin: 0;
			height: 28px;
		}
		.page {
			padding: 0.75rem 0.9rem 4rem;
		}
		.hint {
			display: none;
		}
	}
</style>
