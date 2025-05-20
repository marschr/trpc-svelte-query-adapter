import type { Router } from '$lib/trpc/router';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { svelteQueryWrapper } from 'trpc-svelte-query-adapter';
import type { QueryClient } from '@tanstack/svelte-query';
import { browser } from '$app/environment';

let browserSvelteQueryWrapperClient: ReturnType<typeof svelteQueryWrapper<Router>> | undefined;

export function trpc(queryClient?: QueryClient) {
	if (browser && browserSvelteQueryWrapperClient) {
		return browserSvelteQueryWrapperClient;
	}

	const trpcClientInstance = createTRPCClient<Router>({
		links: [
			httpBatchLink({
				url: '/api/trpc',
				// headers: () => {
				//   // To forward client headers to the server, you can do this.
				//   // Note, however, that it may leak sensitive information.
				//   if (!browser) return {};
				//   return {
				//     cookie: document.cookie,
				//     'x-csrf-token': (document.getElementById('csrf-token') as HTMLMetaElement)?.content
				//   };
				// }
			}),
		],
		// transformer: undefined, // If not using superjson or other transformers
	});

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
