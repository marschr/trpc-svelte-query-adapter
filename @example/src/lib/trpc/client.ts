import type { Router } from '$lib/trpc/router';
import { createTRPCClient, httpBatchLink, splitLink, httpSubscriptionLink } from '@trpc/client';
import { svelteQueryWrapper } from 'trpc-svelte-query-adapter';
import type { QueryClient } from '@tanstack/svelte-query';
import { browser } from '$app/environment';

let browserSvelteQueryWrapperClient: ReturnType<typeof svelteQueryWrapper<Router>> | undefined;
let rawTrpcClient: ReturnType<typeof createTRPCClient<Router>> | undefined;

function getTrpcClient() {
	if (rawTrpcClient) return rawTrpcClient;

	rawTrpcClient = createTRPCClient<Router>({
		links: [
			splitLink({
				condition: (op) => {
					return op.type === 'subscription';
				},
				true: httpSubscriptionLink({
					url: '/api/trpc',
				}),
				false: httpBatchLink({
					url: '/api/trpc',
				}),
			}),
		],
	});
	return rawTrpcClient;
}

export { getTrpcClient as getRawTrpcClient };

export function trpc(queryClient?: QueryClient) {
	if (browser && browserSvelteQueryWrapperClient) {
		return browserSvelteQueryWrapperClient;
	}

	const trpcClientInstance = getTrpcClient();

	const wrapperClient = svelteQueryWrapper<Router>({
		client: trpcClientInstance,
		queryClient, // Pass the svelte-query client instance
		// abortOnUnmount: browser, // Example: Abort requests on unmount in browser
	});

	if (browser) {
		browserSvelteQueryWrapperClient = wrapperClient;
	}
	return wrapperClient;
}
