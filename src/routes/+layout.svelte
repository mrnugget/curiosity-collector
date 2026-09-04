<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
	<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta name="theme-color" content="#3a6ea5" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
	<meta name="apple-mobile-web-app-title" content="Curiosity" />
	<meta name="color-scheme" content="light" />
</svelte:head>

{@render children()}

<style>
	:global {
		:root {
			--desktop: #3a6ea5;
			--chrome: #d4d0c8;
			--chrome-light: #ffffff;
			--chrome-dark: #808080;
			--chrome-darker: #404040;
			--title-start: #0a246a;
			--title-end: #a6caf0;
			--paper: #fdfcf7;
			--paper-dim: #f4f2ea;
			--ink: #1c1c1c;
			--muted: #6f6f6f;
			--faint: #a8a8a8;
			--rule: #e2dfd5;
			--link: #1a4fa0;
			--accent: #0a246a;
			--danger: #a03030;
			--mono: ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
			--ui: Tahoma, 'Segoe UI', system-ui, -apple-system, sans-serif;
		}

		*,
		*::before,
		*::after {
			box-sizing: border-box;
		}

		html {
			background: var(--desktop);
			-webkit-text-size-adjust: 100%;
		}

		body {
			margin: 0;
			min-height: 100dvh;
			font-family: var(--mono);
			font-size: 14px;
			line-height: 1.5;
			color: var(--ink);
			background: var(--desktop);
			-webkit-font-smoothing: antialiased;
			padding-top: env(safe-area-inset-top);
		}

		a {
			color: var(--link);
			text-decoration: none;
		}
		a:hover {
			text-decoration: underline;
		}

		/* Windows 2000 window frame */
		.window {
			background: var(--paper);
			border: 1px solid;
			border-color: var(--chrome-light) var(--chrome-darker) var(--chrome-darker) var(--chrome-light);
			box-shadow:
				inset 1px 1px 0 var(--chrome),
				inset -1px -1px 0 var(--chrome-dark),
				0 0 0 1px var(--chrome),
				0 10px 30px rgba(0, 0, 0, 0.25);
		}

		.titlebar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 1rem;
			height: 22px;
			margin: 2px;
			padding: 0 6px;
			background: linear-gradient(90deg, var(--title-start), var(--title-end));
			color: #fff;
			font-family: var(--ui);
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.01em;
			user-select: none;
		}
		.titlebar .title {
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.titlebar .meta {
			font-weight: 400;
			opacity: 0.85;
			white-space: nowrap;
		}

		/* Classic beveled push button */
		.btn {
			font: inherit;
			font-family: var(--ui);
			font-size: 12px;
			line-height: 1;
			padding: 5px 10px;
			color: #000;
			background: var(--chrome);
			border: 1px solid;
			border-color: var(--chrome-light) var(--chrome-darker) var(--chrome-darker) var(--chrome-light);
			box-shadow:
				inset -1px -1px 0 var(--chrome-dark),
				inset 1px 1px 0 var(--chrome);
			cursor: pointer;
			touch-action: manipulation;
		}
		.btn:active {
			border-color: var(--chrome-darker) var(--chrome-light) var(--chrome-light) var(--chrome-darker);
			box-shadow: inset 1px 1px 0 var(--chrome-dark);
		}
		.btn:focus-visible {
			outline: 1px dotted #000;
			outline-offset: -4px;
		}

		/* Quiet text-only action */
		.quiet {
			font: inherit;
			font-size: 12px;
			padding: 2px 4px;
			margin: 0 -4px;
			color: var(--muted);
			background: none;
			border: 0;
			border-radius: 2px;
			cursor: pointer;
			touch-action: manipulation;
			-webkit-tap-highlight-color: transparent;
		}
		.quiet:hover {
			color: var(--ink);
			background: var(--paper-dim);
		}
		.quiet:focus-visible {
			outline: 1px dotted var(--ink);
		}
		.quiet.danger:hover {
			color: var(--danger);
		}
		@media (pointer: coarse) {
			.quiet {
				font-size: 13px;
				padding: 6px 6px;
				margin: 0 -6px;
			}
		}

		@media (max-width: 640px) {
			body {
				background: var(--paper);
			}
			.window {
				border: 0;
				box-shadow: none;
			}
		}
	}
</style>
