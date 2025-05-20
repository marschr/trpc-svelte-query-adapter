<script lang="ts">
	import Heading from '$lib/components/Heading.svelte';
	import { getRawTrpcClient } from '$lib/trpc/client';
	import { onMount } from 'svelte';
	import type { TRPCClientErrorLike } from '@trpc/client';
	import type { Router } from '$lib/trpc/router';

	let sseTimestamp = 0;
	let sseMessages: string[] = [];

	const rawTrpc = getRawTrpcClient();

	onMount(() => {
		const subscription = rawTrpc.onTimestamp.subscribe(undefined, {
			onStarted: () => {
				console.log('SSE Subscription started');
				sseMessages = ['SSE Subscription started'];
			},
			onData: (data: { timestamp: number }) => {
				console.log('SSE data:', data);
				sseTimestamp = data.timestamp;
				sseMessages = [...sseMessages, `Timestamp: ${data.timestamp}`];
			},
			onError: (err: TRPCClientErrorLike<Router>) => {
				console.error('SSE error:', err);
				sseMessages = [...sseMessages, `Error: ${err.message}`];
			},
			onComplete: () => {
				console.log('SSE Subscription completed');
				sseMessages = [...sseMessages, 'SSE Subscription completed'];
			}
		});

		return () => {
			subscription.unsubscribe();
		};
	});
</script>

<div style="display:flex;flex-direction:column;gap:2rem;">
	<div style="display:flex;align-items:center;justify-content:space-between;">
		<Heading prefix={false}>tRPC - Svelte-Query Adapter Demo</Heading>
	</div>

	<div>
		<h2>Examples</h2>
		<ul>
			<li><a href="/client-only">Client-only</a></li>
			<li><a href="/ssr">SSR</a></li>
			<li><a href="/ssr-with-streaming">SSR with Streaming</a></li>
		</ul>
	</div>

	<div>
		<h2>SSE Timestamp Stream</h2>
		<p>Last received timestamp: {sseTimestamp || 'Waiting...'}</p>
		<h3>Log:</h3>
		<ul>
			{#each sseMessages as message}
				<li>{message}</li>
			{/each}
		</ul>
	</div>
</div>
