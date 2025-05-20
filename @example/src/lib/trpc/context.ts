import type { RequestEvent } from '@sveltejs/kit';
import { mockDb } from '../server/db/mockDb';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function createContext(event: RequestEvent) {
	return {
		db: mockDb,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
