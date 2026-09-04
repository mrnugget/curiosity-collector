<script lang="ts">
	import { tick } from 'svelte';
	import type { Bucket, Item, Link } from '$lib/types';
	import { BUCKETS } from '$lib/types';
	import { hostOf, segmentText } from '$lib/urls';
	import { timeAgo } from '$lib/time';
	import { copyText } from '$lib/client/clipboard';

	interface Props {
		item: Item;
		/** Rendered from the "done" list: offers restore/delete instead of move/done. */
		archived?: boolean;
		onpatch: (patch: { body?: string; bucket?: Bucket; done?: boolean }) => void;
		ondelete: () => void;
	}

	let { item, archived = false, onpatch, ondelete }: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let editor = $state<HTMLTextAreaElement | null>(null);
	let copied = $state<string | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	const segments = $derived(segmentText(item.body));
	const otherBuckets = $derived(BUCKETS.filter((b) => b !== item.bucket));

	const MOVE_HINTS: Record<Bucket, string> = {
		inbox: 'Move back to Inbox: links and thoughts for this week’s issue',
		intro: 'Move to Intro: ideas for the opening of the newsletter',
		later: 'Move to Later: keep for a future issue, out of the way for now'
	};

	async function copy(key: string, text: string) {
		if (!(await copyText(text))) return;
		copied = key;
		clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied = null), 1200);
	}

	function label(key: string, text: string): string {
		return copied === key ? 'copied' : text;
	}

	function titleOf(link: Link): string {
		return link.title ?? hostOf(link.cleanUrl);
	}

	function markdownOf(link: Link): string {
		return `[${(link.title ?? hostOf(link.cleanUrl)).replace(/[[\]]/g, '')}](${link.cleanUrl})`;
	}

	async function startEdit(e: MouseEvent) {
		if (archived) return;
		if ((e.target as HTMLElement).closest('a')) return;
		if (window.getSelection()?.toString()) return; // user was selecting text to copy
		draft = item.body;
		editing = true;
		await tick();
		editor?.focus();
		editor?.setSelectionRange(draft.length, draft.length);
		grow();
	}

	function grow() {
		if (!editor) return;
		editor.style.height = 'auto';
		editor.style.height = `${editor.scrollHeight}px`;
	}

	function finishEdit() {
		if (!editing) return;
		editing = false;
		const next = draft.trim();
		if (!next) {
			ondelete();
			return;
		}
		if (next !== item.body) onpatch({ body: next });
	}

	function cancelEdit() {
		editing = false;
	}

	function onEditorKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			cancelEdit();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			finishEdit();
		}
	}
</script>

<article class="note" id="item-{item.id}" class:archived>
	{#if editing}
		<textarea
			class="editor"
			bind:this={editor}
			bind:value={draft}
			oninput={grow}
			onblur={finishEdit}
			onkeydown={onEditorKeydown}
			spellcheck="false"
		></textarea>
	{:else}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="body" onclick={startEdit} title={archived ? undefined : 'Click to edit'}>
			{#each segments as seg, i (i)}
				{#if seg.type === 'url'}
					<a href={seg.value} target="_blank" rel="noopener noreferrer">{seg.value}</a>
				{:else}
					{seg.value}
				{/if}
			{/each}
		</div>
	{/if}

	{#each item.links as link (link.id)}
		<div class="link" class:pending={link.status === 'pending'}>
			<div class="link-title">
				{#if link.status === 'pending'}
					<span class="muted">fetching title…</span>
				{:else if link.status === 'error'}
					<span class="muted">{hostOf(link.cleanUrl)} — couldn't fetch ({link.error})</span>
				{:else}
					<a href={link.cleanUrl} target="_blank" rel="noopener noreferrer" class="title">{titleOf(link)}</a>
					<span class="host">{link.siteName ?? hostOf(link.cleanUrl)}</span>
				{/if}
			</div>
			{#if link.description}
				<p class="desc">{link.description}</p>
			{/if}
			<div class="row">
				{#if link.title}
					<button class="quiet" onclick={() => copy(`t${link.id}`, link.title!)}
						>{label(`t${link.id}`, 'copy title')}</button
					>
				{/if}
				<button class="quiet" title={link.cleanUrl} onclick={() => copy(`u${link.id}`, link.cleanUrl)}
					>{label(`u${link.id}`, 'copy url')}</button
				>
				<button class="quiet" onclick={() => copy(`m${link.id}`, markdownOf(link))}
					>{label(`m${link.id}`, 'copy md')}</button
				>
			</div>
		</div>
	{/each}

	<div class="row actions">
		<time class="when" datetime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}
			>{timeAgo(item.createdAt)}</time
		>
		<button class="quiet" title="Copy the note text" onclick={() => copy('body', item.body)}
			>{label('body', 'copy text')}</button
		>
		{#if archived}
			<button class="quiet" title="Put this note back where it was" onclick={() => onpatch({ done: false })}
				>restore</button
			>
			<button class="quiet danger" title="Delete this note for good" onclick={ondelete}>delete</button>
		{:else}
			{#each otherBuckets as bucket (bucket)}
				<button class="quiet" title={MOVE_HINTS[bucket]} onclick={() => onpatch({ bucket })}
					>→ {bucket}</button
				>
			{/each}
			<button
				class="quiet done"
				title="Mark as used in the newsletter and move it to Done"
				onclick={() => onpatch({ done: true })}>✓ done</button
			>
		{/if}
	</div>
</article>

<style>
	.note {
		padding: 0.75rem 0 0.9rem;
		border-bottom: 1px solid var(--rule);
		scroll-margin-top: 4rem;
	}
	.note:last-child {
		border-bottom: 0;
	}
	.archived .body {
		color: var(--muted);
	}

	.body {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		cursor: text;
		min-height: 1.5em;
	}

	.editor {
		display: block;
		width: 100%;
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
	}

	.link {
		margin: 0.5rem 0 0 0;
		padding: 0.35rem 0.6rem;
		border-left: 2px solid var(--rule);
		font-size: 13px;
	}
	.link.pending {
		border-left-style: dotted;
	}
	.link-title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 0.6rem;
	}
	.title {
		color: var(--ink);
		font-weight: 600;
	}
	.host {
		color: var(--faint);
		font-size: 12px;
	}
	.muted {
		color: var(--muted);
	}
	.desc {
		margin: 0.15rem 0 0;
		color: var(--muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.9rem;
		margin-top: 0.25rem;
	}
	.actions {
		margin-top: 0.5rem;
	}
	.when {
		font-size: 12px;
		color: var(--faint);
		min-width: 2.5ch;
	}
	.done {
		margin-left: auto;
	}
	.done:hover {
		color: #1f6b2c;
	}

	@media (hover: hover) {
		.note .quiet:not(.done) {
			opacity: 0.6;
		}
		.note:hover .quiet,
		.note:focus-within .quiet {
			opacity: 1;
		}
	}

	@media (max-width: 640px) {
		.editor {
			font-size: 16px;
		}
	}
</style>
