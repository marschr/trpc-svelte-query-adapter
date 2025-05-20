import { createContext } from '$lib/trpc/context';
import { router } from '$lib/trpc/router';
import type { Handle } from '@sveltejs/kit';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

const TRPC_ENDPOINT = '/api/trpc';

export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.pathname.startsWith(TRPC_ENDPOINT)) {
    return await fetchRequestHandler({
      endpoint: TRPC_ENDPOINT,
      req: event.request,
      router,
      createContext: () => createContext(event),
    });
  }
  return resolve(event);
};
