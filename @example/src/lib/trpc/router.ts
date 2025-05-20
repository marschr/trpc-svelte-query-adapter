import { createContext, type Context } from '$lib/trpc/context';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import type { RequestEvent } from '@sveltejs/kit';
import type { Todo } from '$lib/server/db/mockDb'; // Import Todo type

export const t = initTRPC.context<Context>().create();

const loggingMiddleware = t.middleware(async ({ path, type, next, ctx }) => {
	const start = Date.now();
	// Ensure ctx.event is available for logging if needed, e.g., for user identification
	const svelteKitEvent: RequestEvent | undefined = (ctx as any).event; 
	const userAgent = svelteKitEvent?.request.headers.get('user-agent') ?? 'Unknown';
	console.log(`[TRPC SRV] START ${type} "${path}" - User-Agent: ${userAgent}`);
	
	const result = await next();
	
	const durationMs = Date.now() - start;
	if (result.ok) {
		console.log(`[TRPC SRV] OK    ${type} "${path}" - ${durationMs}ms`);
	} else {
		console.error(`[TRPC SRV] ERROR ${type} "${path}" - ${result.error.message} - ${durationMs}ms`);
	}
	return result;
});

// Create a new procedure builder that includes the logging middleware
const loggedProcedure = t.procedure.use(loggingMiddleware);

export const router = t.router({
	todos: t.router({
		create: loggedProcedure
			.input(z.string().min(1, 'Todo text cannot be empty'))
			.mutation(async ({ input: text, ctx: { db } }) => {
				await new Promise((r) => setTimeout(r, 500)); // Shorter delay for mock
				return db.todo.create({ text });
			}),

		get: loggedProcedure
			.input(z.string().optional())
			.query(({ input: filter, ctx: { db } }) =>
				db.todo.findMany({
					where: filter
						? (todo: Todo) => todo.text.toLowerCase().includes(filter.toLowerCase())
						: undefined,
				})
			),

		getPopular: loggedProcedure // This one remains as it fetches from an external API
			.input(
				z.object({
					cursor: z.number().optional(),
					limit: z.number().optional(),
				})
			)
			.query(async ({ input: { cursor: start = 0, limit = 10 } }) => {
				const res = await fetch(
					`https://jsonplaceholder.typicode.com/todos?_start=${start}&_limit=${limit}`
				);
				const todos = (await res.json()) as {
					userId: number;
					id: number;
					title: string;
					completed: boolean;
				}[];

				return { todos, nextCursor: start + limit };
			}),

		update: loggedProcedure
			.input(
				z.object({
					id: z.number(),
					text: z.string().min(1).optional(),
					done: z.boolean().optional(),
				})
			)
			.mutation(({ input: { id, ...newTodoData }, ctx: { db } }) =>
				db.todo.update({ where: { id }, data: newTodoData })
			),

		delete: loggedProcedure
			.input(z.number())
			.mutation(({ input: id, ctx: { db } }) =>
				db.todo.delete({ where: { id } })
			),
	}),
});

const factory = t.createCallerFactory(router);
export const createCaller = async (event: RequestEvent) => {
	return factory(await createContext(event));
};

export type Router = typeof router;
