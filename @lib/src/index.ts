import DeepProxy from 'proxy-deep';

import type {
	TRPCClientErrorLike,
	CreateTRPCClient,
	TRPCUntypedClient,
} from '@trpc/client';
import type { AnyRouter, DeepPartial } from '@trpc/server';

import {
	useQueryClient,
	createQuery,
	createMutation,
	createInfiniteQuery,
	createQueries,
	skipToken,
	hashKey,
	type CreateQueryOptions,
	type CreateMutationOptions,
	type CreateInfiniteQueryOptions,
	type InvalidateQueryFilters,
	type FetchQueryOptions,
	type FetchInfiniteQueryOptions,
	type InfiniteData,
	type RefetchQueryFilters,
	type RefetchOptions,
	type ResetOptions,
	type CancelOptions,
	type Updater,
	type Query,
	type SetDataOptions,
	type QueryClient,
	type InvalidateOptions,
	type CreateQueryResult,
	type CreateInfiniteQueryResult,
	type CreateMutationResult,
	type QueryObserverResult,
	type QueryObserverOptions,
	type DefaultError,
	type OmitKeyof,
	type QueriesPlaceholderDataFunction,
} from '@tanstack/svelte-query';

import { afterUpdate, onDestroy, onMount } from 'svelte';
import {
	derived,
	get,
	writable,
	type Readable,
	type Writable,
} from 'svelte/store';

/**
 * Omits the key without removing a potential union
 * @internal
 */
type DistributiveOmit<TObj, TKey extends keyof any> = TObj extends any
	? Omit<TObj, TKey>
	: never;

type ValueOf<T> = T[keyof T];

type ExhaustiveRecord<
	TKey extends PropertyKey,
	TValue = any,
	U extends
		| (
				{ [K in TKey]: TValue } &
				{ [K in keyof U]: K extends TKey ? TValue : never; }
			)
		| undefined
	= undefined,
> = U extends undefined ? { [K in TKey]: TValue }
	: U extends { [K in TKey]: TValue } ? U
	: never; // prettier-ignore

	type StoreOrVal<T> = T | Readable<T> | Writable<T>;

// CREDIT: https://stackoverflow.com/a/63448246
type WithNevers<T, V> = {
	[K in keyof T]: Exclude<T[K], undefined> extends V
		? never
		: T[K] extends Record<string, unknown>
			? Without<T[K], V>
			: T[K];
};

type Without<T, V, I = WithNevers<T, V>> = Pick<
	I,
	{ [K in keyof I]: I[K] extends never ? never : K }[keyof I]
>;

type HasQuery = { query: (...args: any[]) => any };
type HasMutate = { mutate: (...args: any[]) => any };
type HasSubscribe = { subscribe: (...args: any[]) => any };
type OnlyQueries<TClient> = Without<TClient, HasMutate | HasSubscribe>;

function isSvelteStore<T extends object>(
	obj: StoreOrVal<T>
): obj is Readable<T> {
	return (
		typeof obj === 'object' &&
		'subscribe' in obj &&
		typeof obj.subscribe === 'function'
	);
}

/**
 * Check that value is object
 * @internal
 */
function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && !Array.isArray(value) && typeof value === 'object';
}

const blank = Symbol('blank');
const isBlank = (val: unknown): val is typeof blank => val === blank;
const blankStore: Readable<typeof blank> = {
	subscribe(run) {
		run(blank);
		return () => {};
	},
};

function hasOwn<T extends object>(obj: T, prop: PropertyKey): prop is keyof T {
	return typeof obj === 'object' && Object.hasOwn(obj as any, prop);
}

const Procedure = {
	query: 'createQuery',
	serverQuery: 'createServerQuery',
	infiniteQuery: 'createInfiniteQuery',
	serverInfiniteQuery: 'createServerInfiniteQuery',
	mutate: 'createMutation',
	subscribe: 'createSubscription',
	queryKey: 'getQueryKey',
	context: 'createContext',
	utils: 'createUtils',
	queries: 'createQueries',
	serverQueries: 'createServerQueries',
} as const;

const Util = {
	Query: {
		client: 'client',
		fetch: 'fetch',
		prefetch: 'prefetch',
		fetchInfinite: 'fetchInfinite',
		prefetchInfinite: 'prefetchInfinite',
		ensureData: 'ensureData',
		invalidate: 'invalidate',
		refetch: 'refetch',
		reset: 'reset',
		cancel: 'cancel',
		setData: 'setData',
		getData: 'getData',
		setInfiniteData: 'setInfiniteData',
		getInfiniteData: 'getInfiniteData',
	},

	Mutation: {
		setMutationDefaults: 'setMutationDefaults',
		getMutationDefaults: 'getMutationDefaults',
		isMutating: 'isMutating',
	},
} as const;

// getQueryKey
type GetInfiniteQueryInput<
	TProcedureInput,
	TInputWithoutCursorAndDirection = Omit<
		TProcedureInput,
		'cursor' | 'direction'
	>,
> = keyof TInputWithoutCursorAndDirection extends never
	? undefined
	: DeepPartial<TInputWithoutCursorAndDirection> | undefined;

type GetQueryProcedureInput<TProcedureInput> = TProcedureInput extends {
	cursor?: any;
}
	? GetInfiniteQueryInput<TProcedureInput>
	: DeepPartial<TProcedureInput> | undefined;

type QueryType = 'query' | 'infinite' | 'any';

export type TRPCQueryKey = [
	readonly string[],
	{ input?: unknown; type?: Exclude<QueryType, 'any'> }?,
];

export type TRPCMutationKey = [readonly string[]]; // = [TRPCQueryKey[0]]

type QueryKeyKnown<TInput, TType extends Exclude<QueryType, 'any'>> = [
	string[],
	{ input?: GetQueryProcedureInput<TInput>; type: TType }?,
];

function getQueryKeyInternal(
	path: readonly string[],
	input: unknown,
	type: QueryType
): TRPCQueryKey {
	// Construct a query key that is easy to destructure and flexible for
	// partial selecting etc.
	// https://github.com/trpc/trpc/issues/3128

	// some parts of the path may be dot-separated, split them up
	const splitPath = path.flatMap((part) => part.split('.'));

	if (!input && (!type || type === 'any')) {
		// this matches also all mutations (see `getMutationKeyInternal`)

		// for `utils.invalidate()` to match all queries (including vanilla react-query)
		// we don't want nested array if path is empty, i.e. `[]` instead of `[[]]`
		return splitPath.length ? [splitPath] : ([] as unknown as TRPCQueryKey);
	}

	if (
		type === 'infinite' &&
		isObject(input) &&
		('direction' in input || 'cursor' in input)
	) {
		const {
			cursor: _,
			direction: __,
			...inputWithoutCursorAndDirection
		} = input;
		return [
			splitPath,
			{
				input: inputWithoutCursorAndDirection,
				type: 'infinite',
			},
		];
	}
	return [
		splitPath,
		{
			...(typeof input !== 'undefined' &&
				input !== skipToken && { input: input }),
			...(type && type !== 'any' && { type: type }),
		},
	];
}

function getMutationKeyInternal(path: readonly string[]) {
	return getQueryKeyInternal(path, undefined, 'any') as TRPCMutationKey;
}

type GetQueryKey<TInput = undefined> = [TInput] extends [undefined | void]
	? {
			/**
			 * @deprecated import `getQueryKey` from `trpc-svelte-query-adapter` instead
			 */
			[Procedure.queryKey]: () => TRPCQueryKey;
		}
	: {
			/**
			 * @deprecated import `getQueryKey` from `trpc-svelte-query-adapter` instead
			 *
			 * Method to extract the query key for a procedure
			 * @param type - defaults to `any`
			 */
			[Procedure.queryKey]: (input?: TInput, type?: QueryType) => TRPCQueryKey;
		} & {};

// createUtils
type TRPCFetchQueryOptions<TOutput, TError, TData = TOutput> = DistributiveOmit<
	FetchQueryOptions<TOutput, TError, TData>,
	'queryKey'
>;

type TRPCFetchInfiniteQueryOptions<TInput, TOutput, TError> = DistributiveOmit<
	FetchInfiniteQueryOptions<TInput, TOutput, TError>,
	'queryKey' | 'initialPageParam'
>;

type QueryUtils<
	TInput = undefined,
	TOutput = undefined,
	TError = undefined
> = ExhaustiveRecord<Exclude<ValueOf<typeof Util.Query>, 'client'>, any, {
	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientfetchquery
	 */
	[Util.Query.fetch](
		input: TInput,
		opts?: TRPCFetchQueryOptions<TOutput, TError>
	): Promise<TOutput>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientfetchinfinitequery
	 */
	[Util.Query.fetchInfinite](
		input: TInput,
		opts?: TRPCFetchInfiniteQueryOptions<TInput, TOutput, TError>
	): Promise<
		InfiniteData<TOutput, NonNullable<ExtractCursorType<TInput>> | null>
	>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientprefetchquery
	 */
	[Util.Query.prefetch](
		input: TInput,
		opts?: TRPCFetchQueryOptions<TOutput, TError>
	): Promise<void>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientprefetchinfinitequery
	 */
	[Util.Query.prefetchInfinite](
		input: TInput,
		opts?: TRPCFetchInfiniteQueryOptions<TInput, TOutput, TError>
	): Promise<void>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientensurequerydata
	 */
	[Util.Query.ensureData](
		input: TInput,
		opts?: TRPCFetchQueryOptions<TOutput, TError>
	): Promise<TOutput>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientinvalidatequeries
	 */
	[Util.Query.invalidate](
		input?: DeepPartial<TInput>,
		filters?: Omit<InvalidateQueryFilters, 'predicate'> & {
			predicate?: (
				query: Query<
					TInput,
					TError,
					TInput,
					QueryKeyKnown<
						TInput,
						TInput extends { cursor?: any } | void ? 'infinite' : 'query'
					>
				>
			) => boolean;
		},
		options?: InvalidateOptions
	): Promise<void>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientrefetchqueries
	 */
	[Util.Query.refetch](
		input?: TInput,
		filters?: RefetchQueryFilters,
		options?: RefetchOptions
	): Promise<void>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientcancelqueries
	 */
	[Util.Query.cancel](input?: TInput, options?: CancelOptions): Promise<void>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientresetqueries
	 */
	[Util.Query.reset](input?: TInput, options?: ResetOptions): Promise<void>;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientsetquerydata
	 */
	[Util.Query.setData](
		/**
		 * The input of the procedure
		 */
		input: TInput,
		updater: Updater<TOutput | undefined, TOutput | undefined>,
		options?: SetDataOptions
	): void;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientsetquerydata
	 */
	[Util.Query.setInfiniteData](
		input: TInput,
		updater: Updater<
			| InfiniteData<TOutput, NonNullable<ExtractCursorType<TInput>> | null>
			| undefined,
			| InfiniteData<TOutput, NonNullable<ExtractCursorType<TInput>> | null>
			| undefined
		>,
		options?: SetDataOptions
	): void;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientgetquerydata
	 */
	[Util.Query.getData](input?: TInput): TOutput | undefined;

	/**
	 * @link https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientgetquerydata
	 */
	[Util.Query.getInfiniteData](
		input?: TInput
	):
		| InfiniteData<TOutput, NonNullable<ExtractCursorType<TInput>> | null>
		| undefined;
}>; // prettier-ignore

type MutationUtils<
	TInput = undefined,
	TOutput = undefined,
	TError = undefined,
> = ExhaustiveRecord<ValueOf<typeof Util.Mutation>, any, {
	[Util.Mutation.setMutationDefaults](
		opts:
			| CreateMutationOptions<TInput, TOutput, TError>
			| ((args: {
					canonicalMutationFn: NonNullable<
						CreateMutationOptions<TInput, TOutput, TError>['mutationFn']
					>;
			  }) => CreateMutationOptions<TInput, TOutput, TError>)
	): void;

	[Util.Mutation.getMutationDefaults]():
		| CreateMutationOptions<TInput, TOutput, TError>
		| undefined;

	[Util.Mutation.isMutating](): number;
}>; // prettier-ignore

type AddUtilsPropTypes<TClient, TError> = {
	[K in keyof TClient]:
		TClient[K] extends HasQuery ? QueryUtils<
				Parameters<TClient[K]['query']>[0],
				Awaited<ReturnType<TClient[K]['query']>>,
				TError
			>
	: TClient[K] extends HasMutate ? MutationUtils<
			Parameters<TClient[K]['mutate']>[0],
			Awaited<ReturnType<TClient[K]['mutate']>>,
			TError
	>
	: AddUtilsPropTypes<TClient[K], TError> &
			Pick<QueryUtils, typeof Util.Query.invalidate>;
}; // prettier-ignore

type CreateUtilsProcedure<TClient, TError> = {
	/**
	 * @see https://trpc.io/docs/client/react/useUtils
	 */
	[Procedure.utils](): AddUtilsPropTypes<TClient, TError> &
		Pick<QueryUtils, typeof Util.Query.invalidate> & {
			[Util.Query.client]: TClient;
		};

	/**
	 * @deprecated renamed to `createUtils` and will be removed in a future tRPC version
	 *
	 * @see https://trpc.io/docs/client/react/useUtils
	 */
	[Procedure.context](): AddUtilsPropTypes<TClient, TError> &
		Pick<QueryUtils, typeof Util.Query.invalidate> & {
			[Util.Query.client]: TClient;
		};
} & {};

const utilProcedures: Record<
	| Exclude<ValueOf<typeof Util.Query>, 'client'>
	| ValueOf<typeof Util.Mutation>, // prettier-ignore
	(ctx: SvelteQueryWrapperContext) => any
> = {
	// QueryUtils
	[Util.Query.fetch]: ({ path, queryClient, trpcProxyClient, key }) => {
		return (input: any, opts?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.fetchQuery({
				...opts,
				queryKey,
				queryFn: () => {
					let targetProc: any = trpcProxyClient;
					for (const p of path) targetProc = targetProc[p];
					const procedureInput = queryKey[1]?.input;
					return targetProc.query(procedureInput, opts?.trpc);
				}
			});
		};
	},
	[Util.Query.fetchInfinite]: ({ path, queryClient, trpcProxyClient, key }) => {
		return (input: any, opts?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.fetchInfiniteQuery({
				...opts,
				queryKey,
				queryFn: ({ pageParam, direction }) => {
					let targetProc: any = trpcProxyClient;
					for (const p of path) targetProc = targetProc[p];
					const procedureInput = { ...(queryKey[1]?.input ?? {}), ...(pageParam ? { cursor: pageParam } : {}), direction };
					return targetProc.query(procedureInput, opts?.trpc);
				},
				initialPageParam: opts?.initialCursor ?? null,
			});
		};
	},
	[Util.Query.prefetch]: ({ path, queryClient, trpcProxyClient, key }) => {
		return (input: any, opts?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.prefetchQuery({
				...opts,
				queryKey,
				queryFn: () => {
					let targetProc: any = trpcProxyClient;
					for (const p of path) targetProc = targetProc[p];
					const procedureInput = queryKey[1]?.input;
					return targetProc.query(procedureInput, opts?.trpc);
				}
			});
		};
	},
	[Util.Query.prefetchInfinite]: ({ path, queryClient, trpcProxyClient, key }) => {
		return (input: any, opts?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.prefetchInfiniteQuery({
				...opts,
				queryKey,
				queryFn: ({ pageParam, direction }) => {
					let targetProc: any = trpcProxyClient;
					for (const p of path) targetProc = targetProc[p];
					const procedureInput = { ...(queryKey[1]?.input ?? {}), ...(pageParam ? { cursor: pageParam } : {}), direction };
					return targetProc.query(procedureInput, opts?.trpc);
				},
				initialPageParam: opts?.initialCursor ?? null,
			});
		};
	},
	[Util.Query.ensureData]: ({ path, queryClient, trpcProxyClient, key }) => {
		return (input: any, opts?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.ensureQueryData({
				...opts,
				queryKey,
				queryFn: () => {
					let targetProc: any = trpcProxyClient;
					for (const p of path) targetProc = targetProc[p];
					const procedureInput = queryKey[1]?.input;
					return targetProc.query(procedureInput, opts?.trpc);
				}
			});
		};
	},
	[Util.Query.invalidate]: ({ path, queryClient, key }) => {
		return (input?: any, filters?: any, options?: any) => {
			console.log(path, input, getQueryType(key as any));
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.invalidateQueries(
				{
					...filters,
					queryKey,
				},
				options
			);
		};
	},
	[Util.Query.reset]: ({ queryClient, path, key }) => {
		return (input?: any, filters?: any, options?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.resetQueries(
				{
					...filters,
					queryKey,
				},
				options
			);
		};
	},
	[Util.Query.refetch]: ({ path, queryClient, key }) => {
		return (input?: any, filters?: any, options?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.refetchQueries(
				{
					...filters,
					queryKey,
				},
				options
			);
		};
	},
	[Util.Query.cancel]: ({ path, queryClient, key }) => {
		return (input?: any, options?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.cancelQueries(
				{
					queryKey,
				},
				options
			);
		};
	},
	[Util.Query.setData]: ({ queryClient, path, key }) => {
		return (input: any, updater: any, options?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.setQueryData(queryKey, updater as any, options);
		};
	},
	[Util.Query.setInfiniteData]: ({ queryClient, path, key }) => {
		return (input: any, updater: any, options?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.setQueryData(queryKey, updater as any, options);
		};
	},
	[Util.Query.getData]: ({ queryClient, path, key }) => {
		return (input?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.getQueryData(queryKey);
		};
	},
	[Util.Query.getInfiniteData]: ({ queryClient, path, key }) => {
		return (input?: any) => {
			const queryKey = getQueryKeyInternal(
				path,
				input,
				getQueryType(key as any)
			);
			return queryClient.getQueryData(queryKey);
		};
	},

	// MutationUtils
	[Util.Mutation.setMutationDefaults]: ({ queryClient, path: _path, trpcProxyClient }) => {
		return (options: any) => {
			const mutationKey = getMutationKeyInternal(_path);
			const procedurePath = mutationKey[0];
			const canonicalMutationFn = (input: unknown) => {
				let targetProc: any = trpcProxyClient;
				for (const p of procedurePath) targetProc = targetProc[p];
				return targetProc.mutate(input);
			};
			const actualOptions = typeof options === 'function'
					? options({ canonicalMutationFn })
					: options;
			return queryClient.setMutationDefaults(mutationKey, actualOptions);
		};
	},
	[Util.Mutation.getMutationDefaults]: ({ queryClient, path: _path }) => {
		return () => {
			console.warn(
				'[trpc-svelte-query-adapter] getMutationDefaults utility is not able to retrieve defaults with Svelte Query v5 and will return undefined.'
			);
			return undefined;
		};
	},
	[Util.Mutation.isMutating]: ({ queryClient, path }) => {
		return () => {
			return queryClient.isMutating({
				mutationKey: getMutationKeyInternal(path),
				exact: true,
			});
		};
	},
};

function createUtilsProxy(ctx: SvelteQueryWrapperContext) {
	return new DeepProxy(
		{},
		{
			get(_target, key, _receiver) {
				if (key === Util.Query.client) return ctx.trpcProxyClient;

				if (hasOwn(utilProcedures, key)) {
					return utilProcedures[key](
						Object.assign(ctx, { key, path: this.path })
					);
				}

				return this.nest(() => {});
			},
		}
	);
}

// createQueries
// REFER: https://github.com/trpc/trpc/blob/936db6dd2598337758e29c843ff66984ed54faaf/packages/react-query/src/internals/useQueries.ts#L33
type QueriesResults<
	TQueriesOptions extends CreateQueryOptionsForCreateQueries<
		any,
		any,
		any,
		any
	>[],
> = {
	[TKey in keyof TQueriesOptions]: TQueriesOptions[TKey] extends CreateQueryOptionsForCreateQueries<
		infer TQueryFnData,
		infer TError,
		infer TData,
		any
	>
		? QueryObserverResult<unknown extends TData ? TQueryFnData : TData, TError>
		: never;
};

type QueryObserverOptionsForCreateQueries<
	TQueryFnData = unknown,
	TError = DefaultError,
	TData = TQueryFnData,
	TQueryKey extends TRPCQueryKey = TRPCQueryKey,
> = OmitKeyof<
	QueryObserverOptions<TQueryFnData, TError, TData, TQueryFnData, TQueryKey>,
	'placeholderData'
> & {
	placeholderData?: TQueryFnData | QueriesPlaceholderDataFunction<TQueryFnData>;
};

type CreateQueryOptionsForCreateQueries<
	TOutput = unknown,
	TError = unknown,
	TData = unknown,
	TQueryKey extends TRPCQueryKey = TRPCQueryKey,
> = Omit<
	QueryObserverOptionsForCreateQueries<TOutput, TError, TData, TQueryKey>,
	'context' | 'queryKey' | 'queryFn'
> &
	TRPCQueryOpts;

type CreateQueriesRecord<TClient, TError> = {
	[K in keyof TClient]: TClient[K] extends HasQuery
		? <TOutput = Awaited<ReturnType<TClient[K]['query']>>, TData = TOutput>(
				input: Parameters<TClient[K]['query']>[0],
				opts?: CreateQueryOptionsForCreateQueries<TOutput, TError, TData>
			) => CreateQueryOptionsForCreateQueries<TOutput, TError, TData>
		: CreateQueriesRecord<TClient[K], TError>;
};

type CreateQueriesOpts<
	TOpts extends CreateQueryOptionsForCreateQueries[],
	TCombinedResult,
> = {
	combine?: (result: QueriesResults<TOpts>) => TCombinedResult;
};

// createServerQueries
type CreateQueryOptionsForCreateServerQueries<
	TOutput = unknown,
	TError = unknown,
	TData = unknown,
	TQueryKey extends TRPCQueryKey = TRPCQueryKey,
> = CreateQueryOptionsForCreateQueries<TOutput, TError, TData, TQueryKey> & {
	ssr?: boolean;
};

type CreateServerQueriesRecord<TClient, TError> = {
	[K in keyof TClient]: TClient[K] extends HasQuery
		? <TOutput = Awaited<ReturnType<TClient[K]['query']>>, TData = TOutput>(
				input: Parameters<TClient[K]['query']>[0],
				opts?: CreateQueryOptionsForCreateServerQueries<TOutput, TError, TData>
			) => CreateQueryOptionsForCreateServerQueries<TOutput, TError, TData>
		: CreateServerQueriesRecord<TClient[K], TError>;
};

type CreateQueriesProcedure<TClient = any, TError = any> = {
	[Procedure.queries]: <
		TOpts extends CreateQueryOptionsForCreateQueries<any, any, any, any>[],
		TCombinedResult = QueriesResults<TOpts>,
	>(
		queriesCallback: (
			t: CreateQueriesRecord<OnlyQueries<TClient>, TError>
		) => StoreOrVal<readonly [...TOpts]>,
		opts?: CreateQueriesOpts<TOpts, TCombinedResult>
	) => Readable<TCombinedResult>;

	[Procedure.serverQueries]: <
		TOpts extends CreateQueryOptionsForCreateServerQueries<
			any,
			any,
			any,
			any
		>[],
		TCombinedResult = QueriesResults<TOpts>,
	>(
		queriesCallback: (
			t: CreateServerQueriesRecord<OnlyQueries<TClient>, TError>
		) => readonly [...TOpts],
		opts?: CreateQueriesOpts<TOpts, TCombinedResult>
	) => Promise<
		(
			queriesCallback?: (
				t: CreateServerQueriesRecord<OnlyQueries<TClient>, TError>,
				old: readonly [...TOpts]
			) => StoreOrVal<readonly [...TOpts]>,
			opts?: CreateQueriesOpts<TOpts, TCombinedResult>
		) => Readable<TCombinedResult>
	>;
} & {};

// Procedures
type TRPCQueryOpts = {
	trpc?: {
		abortOnUnmount?: boolean;
	};
};

type CreateTRPCQueryOptions<
	TOutput,
	TError,
	TData,
	TEnv extends 'client' | 'server' = 'client'
> = Omit<CreateQueryOptions<TOutput, TError, TData>, 'queryKey' | 'queryFn'>
	& (TEnv extends 'server' ? { ssr?: boolean } : {})
	& TRPCQueryOpts
; // prettier-ignore

type CreateQueryProcedure<TInput = any, TOutput = any, TError = any> = {
	[Procedure.query]: {
		<TData = TOutput, TLazy extends boolean = false>(
			input: StoreOrVal<TInput>,
			opts?: StoreOrVal<
				CreateTRPCQueryOptions<TOutput, TError, TData> & { lazy?: TLazy }
			>
		): TLazy extends true
			? [
					CreateQueryResult<TData, TError>,
					(data?: Promise<TData>) => Promise<void>,
				]
			: CreateQueryResult<TData, TError>;

		opts: <TData = TOutput, TLazy extends boolean = false>(
			opts: CreateTRPCQueryOptions<TOutput, TError, TData> & { lazy?: TLazy }
		) => CreateTRPCQueryOptions<TOutput, TError, TData> & { lazy?: TLazy }; // prettier-ignore
	};

	[Procedure.serverQuery]: <TData = TOutput>(
		input: TInput,
		opts?: CreateTRPCQueryOptions<TOutput, TError, TData, 'server'>
	) => Promise<
		<TData = TOutput>(
			input?: StoreOrVal<TInput> | ((old: TInput) => StoreOrVal<TInput>),
			opts?: StoreOrVal<CreateTRPCQueryOptions<TOutput, TError, TData>>
		) => CreateQueryResult<TData, TError>
	>;
} & {};

type ExtractCursorType<TInput> = TInput extends { cursor?: any }
	? TInput['cursor']
	: unknown;

type CreateTRPCInfiniteQueryOptions<
	TInput,
	TOutput,
	TError,
	TData,
	TEnv extends 'client' | 'server' = 'client'
> = Omit<
			CreateInfiniteQueryOptions<TOutput, TError, TData, TData, any, ExtractCursorType<TInput>>,
			'queryKey' | 'queryFn' | 'initialPageParam'
		>
	& { initialCursor?: ExtractCursorType<TInput> }
	& (TEnv extends 'server' ? { ssr?: boolean } : {})
	& TRPCQueryOpts
; // prettier-ignore

type CreateInfiniteQueryProcedure<TInput = any, TOutput = any, TError = any> = {
	[Procedure.infiniteQuery]: {
		<TData = TOutput, TLazy extends boolean = false>(
			input: StoreOrVal<Omit<TInput, 'cursor'>>,
			opts: StoreOrVal<
				CreateTRPCInfiniteQueryOptions<TInput, TOutput, TError, TData> & {
					lazy?: TLazy;
				}
			>
		): TLazy extends true
			? [
					CreateInfiniteQueryResult<
						InfiniteData<TData, NonNullable<ExtractCursorType<TInput>> | null>,
						TError
					>,
					(data?: Promise<TData>) => Promise<void>,
				]
			: CreateInfiniteQueryResult<
					InfiniteData<TData, NonNullable<ExtractCursorType<TInput>> | null>,
					TError
				>;

		opts: <TData = TOutput>(
			opts: CreateTRPCInfiniteQueryOptions<TInput, TOutput, TError, TData>
		) => CreateTRPCInfiniteQueryOptions<TInput, TOutput, TError, TData>; // prettier-ignore
	};

	[Procedure.serverInfiniteQuery]: <TData = TOutput>(
		input: Omit<TInput, 'cursor'>,
		opts: CreateTRPCInfiniteQueryOptions<
			TInput,
			TOutput,
			TError,
			TData,
			'server'
		>
	) => Promise<
		<TData = TOutput>(
			input?:
				| StoreOrVal<Omit<TInput, 'cursor'>>
				| ((old: Omit<TInput, 'cursor'>) => StoreOrVal<Omit<TInput, 'cursor'>>),
			opts?: StoreOrVal<
				CreateTRPCInfiniteQueryOptions<TInput, TOutput, TError, TData>
			>
		) => CreateInfiniteQueryResult<
			InfiniteData<TData, NonNullable<ExtractCursorType<TInput>> | null>,
			TError
		>
	>;
};

type QueryProcedures<TInput, TOutput, TError> =
		CreateQueryProcedure<TInput, TOutput, TError>
	& (TInput extends { cursor?: any }
			? CreateInfiniteQueryProcedure<TInput, TOutput, TError>
			: {})
	& GetQueryKey<TInput>
; // prettier-ignore

type CreateMutationProcedure<
	TInput = any,
	TOutput = any,
	TError = any,
	TContext = unknown,
> = {
	[Procedure.mutate]: {
		(
			opts?: CreateMutationOptions<TOutput, TError, TInput, TContext>
		): CreateMutationResult<TOutput, TError, TInput, TContext>;

		opts: (
			opts: CreateMutationOptions<TOutput, TError, TInput, TContext>
		) => CreateMutationOptions<TOutput, TError, TInput, TContext>; // prettier-ignore
	};
} & {};

type CreateSubscriptionOptions<TOutput, TError> = {
	enabled?: boolean;
	onStarted?: () => void;
	onData: (data: TOutput) => void;
	onError?: (err: TError) => void;
};

type GetSubscriptionOutput<TOpts> = TOpts extends unknown & Partial<infer A>
	? A extends { onData: any }
		? Parameters<A['onData']>[0]
		: never
	: never;

type CreateSubscriptionProcedure<TInput = any, TOutput = any, TError = any> = {
	[Procedure.subscribe]: {
		(input: TInput, opts?: CreateSubscriptionOptions<TOutput, TError>): void;

		opts: (
			opts: CreateSubscriptionOptions<TOutput, TError>
		) => CreateSubscriptionOptions<TOutput, TError>; // prettier-ignore
	};
} & {};

type AddQueryPropTypes<TClient = any, TError = any> = {
	[K in keyof TClient]: TClient[K] extends HasQuery
		? QueryProcedures<
				Parameters<TClient[K]['query']>[0],
				Awaited<ReturnType<TClient[K]['query']>>,
				TError
			> & {}
		: TClient[K] extends HasMutate
			? CreateMutationProcedure<
					Parameters<TClient[K]['mutate']>[0],
					Awaited<ReturnType<TClient[K]['mutate']>>,
					TError
				>
			: TClient[K] extends HasSubscribe
				? CreateSubscriptionProcedure<
						Parameters<TClient[K]['subscribe']>[0],
						GetSubscriptionOutput<Parameters<TClient[K]['subscribe']>[1]>,
						TError
					>
				: AddQueryPropTypes<TClient[K], TError> & GetQueryKey;
};

type UntypedClient = TRPCUntypedClient<AnyRouter>;

interface SvelteQueryWrapperContext {
	trpcProxyClient: CreateTRPCClient<AnyRouter>;
	queryClient: QueryClient;
	path: string[];
	key: string;
	abortOnUnmount?: boolean;
}

function getQueryType(
	utilName:
		| Exclude<keyof typeof Util.Query, 'client'>
		| keyof typeof Util.Mutation
): QueryType {
	switch (utilName) {
		case 'fetch':
		case 'ensureData':
		case 'prefetch':
		case 'getData':
		case 'setData':
			// case 'setQueriesData':
			return 'query';

		case 'fetchInfinite':
		case 'prefetchInfinite':
		case 'getInfiniteData':
		case 'setInfiniteData':
			return 'infinite';

		case 'setMutationDefaults':
		case 'getMutationDefaults':
		case 'isMutating':
		case 'cancel':
		case 'invalidate':
		case 'refetch':
		case 'reset':
			return 'any';
	}
}

function createQueriesProxy({ trpcProxyClient, abortOnUnmount }: SvelteQueryWrapperContext) {
	return new DeepProxy(
		{},
		{
			get() {
				return this.nest(() => {});
			},
			apply(_target, _thisArg, argList) {
				const [input, opts] = argList;
				const procedurePath = this.path;

				const shouldAbortOnUnmount =
					opts?.trpc?.abortOnUnmount ?? abortOnUnmount;

				const queryKey = getQueryKeyInternal(procedurePath, input, 'query');

				return {
					...opts,
					queryKey,
					queryFn: ({ signal }) => {
						let targetProc: any = trpcProxyClient;
						for (const p of procedurePath) targetProc = targetProc[p];
						const trpcSpecificOptions = { ...opts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
						return targetProc.query(input, trpcSpecificOptions);
					}
				} satisfies CreateQueryOptions;
			},
		}
	);
}

// CREDIT: https://svelte.dev/repl/300c16ee38af49e98261eef02a9b04a8?version=3.38.2
function effect<T extends CallableFunction, U>(
	cb: () => T | void,
	deps: () => U[]
) {
	let cleanup: T | void;

	function apply() {
		if (cleanup) cleanup();
		cleanup = cb();
	}

	if (deps) {
		let values: U[] = [];
		afterUpdate(() => {
			const new_values = deps();
			if (new_values.some((value, i) => value !== values[i])) {
				apply();
				values = new_values;
			}
		});
	} else {
		// no deps = always run
		afterUpdate(apply);
	}

	onDestroy(() => {
		if (cleanup) cleanup();
	});
}

const procedures: Record<
	ValueOf<typeof Procedure>,
	(ctx: SvelteQueryWrapperContext) => any
> = {
	[Procedure.queryKey]: ({ path }) => {
		return (input?: any, opts?: any) => getQueryKeyInternal(path, input, opts);
	},
	[Procedure.query]: ({ path, trpcProxyClient, abortOnUnmount, queryClient }) => {
		return (procedureInput: any, opts?: any) => {
			const isOptsStore = isSvelteStore(opts);
			const isInputStore = isSvelteStore(procedureInput);
			const currentOpts = isOptsStore ? get(opts) : opts;

			const baseQueryKey = getQueryKeyInternal(path, isInputStore ? {} : procedureInput, 'query');

			if (!isInputStore && !isOptsStore && !currentOpts?.lazy) {
				const shouldAbortOnUnmount =
					currentOpts?.trpc?.abortOnUnmount ?? abortOnUnmount;
				const queryKey = getQueryKeyInternal(path, procedureInput, 'query');

				return createQuery({
					...currentOpts,
					queryKey,
					queryFn: ({ signal }) => {
						let targetProc: any = trpcProxyClient;
						for (const p of path) targetProc = targetProc[p];
						const trpcSpecificOptions = { ...currentOpts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
						return targetProc.query(procedureInput, trpcSpecificOptions);
					},
				});
			}

			const shouldAbortOnUnmount =
				currentOpts?.trpc?.abortOnUnmount ?? abortOnUnmount;
			const enabled = currentOpts?.lazy ? writable(false) : blankStore;

			const query = createQuery(
				derived(
					[
						isInputStore ? procedureInput : blankStore,
						isOptsStore ? opts : blankStore,
						enabled,
					],
					([$input, $opts, $enabled]) => {
						const currentProcedureInputVal = !isBlank($input) ? $input : procedureInput;
						const newOpts = !isBlank($opts) ? $opts : currentOpts;
						const queryKey = getQueryKeyInternal(path, currentProcedureInputVal, 'query');

						return {
							...newOpts,
							queryKey,
							queryFn: ({ signal }) => {
								let targetProc: any = trpcProxyClient;
								for (const p of path) targetProc = targetProc[p];
								const trpcSpecificOptions = { ...newOpts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
								return targetProc.query(currentProcedureInputVal, trpcSpecificOptions);
							},
							...(!isBlank($enabled) && {
								enabled: $enabled && (newOpts?.enabled ?? true),
							}),
						} satisfies CreateQueryOptions;
					}
				)
			);

			return currentOpts?.lazy
				? [
						query,
						async (data?: any) => {
							if (data) {
								queryClient.setQueryData(baseQueryKey, await data);
							}
							(enabled as Writable<boolean>).set(true);
						},
				  ]
				: query;
		};
	},
	[Procedure.serverQuery]: ({ path, trpcProxyClient, queryClient, abortOnUnmount }) => {
		return async (_input: any, _opts?: any) => {
			let procedureInput = _input;
			let opts = _opts;
			let shouldAbortOnUnmount = opts?.trpc?.abortOnUnmount ?? abortOnUnmount;

			const queryKey = getQueryKeyInternal(path, procedureInput, 'query');

			const queryFnForPrefetch = ({ signal }: { signal?: AbortSignal }) => {
				let targetProc: any = trpcProxyClient;
				for (const p of path) targetProc = targetProc[p];
				const trpcSpecificOptions = { ...opts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
				return targetProc.query(procedureInput, trpcSpecificOptions);
			};

			const queryForPrefetch: FetchQueryOptions = {
				queryKey,
				queryFn: queryFnForPrefetch,
			};

			const cache = queryClient
				.getQueryCache()
				.find({ queryKey: queryForPrefetch.queryKey });
			const cacheNotFound = !cache?.state?.data;
			if (opts?.ssr !== false && cacheNotFound) {
				await queryClient.prefetchQuery(queryForPrefetch);
			}

			return (...args: any[]) => {
				if (args.length > 0) procedureInput = args.shift();
				if (args.length > 0) opts = args.shift();

				const isOptsStore = isSvelteStore(opts);
				const currentOpts = isOptsStore ? get(opts) : opts;
				shouldAbortOnUnmount =
					currentOpts?.trpc?.abortOnUnmount ?? abortOnUnmount;

				const staleTime = writable<number | null>(Infinity);
				onMount(() => { staleTime.set(null); });

				return createQuery(
					derived(
						[
							isSvelteStore(procedureInput) ? procedureInput : blankStore,
							isOptsStore ? opts : blankStore,
							staleTime,
						],
						([$input, $opts, $staleTime]) => {
							const currentProcedureInputVal = !isBlank($input) ? $input : procedureInput;
							const newOpts = !isBlank($opts) ? $opts : currentOpts;
							const queryKey = getQueryKeyInternal(path, currentProcedureInputVal, 'query');
							return {
								...newOpts,
								queryKey,
								queryFn: ({ signal }) => {
									let targetProc: any = trpcProxyClient;
									for (const p of path) targetProc = targetProc[p];
									const trpcSpecificOptions = { ...newOpts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
									return targetProc.query(currentProcedureInputVal, trpcSpecificOptions);
								},
								...($staleTime && { staleTime: $staleTime }),
							} satisfies CreateQueryOptions;
						}
					)
				);
			};
		};
	},
	[Procedure.infiniteQuery]: ({ path, trpcProxyClient, abortOnUnmount, queryClient }) => {
		return (procedureInput: any, opts?: any) => {
			const isOptsStore = isSvelteStore(opts);
			const isInputStore = isSvelteStore(procedureInput);
			const currentOpts = isOptsStore ? get(opts) : opts;
			const baseQueryKey = getQueryKeyInternal(path, isInputStore ? {} : procedureInput, 'infinite');

			if (!isInputStore && !isOptsStore && !currentOpts?.lazy) {
				const shouldAbortOnUnmount =
					currentOpts?.trpc?.abortOnUnmount ?? abortOnUnmount;
				const queryKey = getQueryKeyInternal(path, procedureInput, 'infinite');

				return createInfiniteQuery({
					...currentOpts,
					initialPageParam: currentOpts?.initialCursor ?? null,
					queryKey,
					queryFn: ({ pageParam, signal, direction }) => {
						let targetProc: any = trpcProxyClient;
						for (const p of path) targetProc = targetProc[p];
						const actualInput = { ...(procedureInput ?? {}), ...(pageParam ? { cursor: pageParam } : {}), direction, };
						const trpcSpecificOptions = { ...currentOpts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
						return targetProc.query(actualInput, trpcSpecificOptions);
					},
				} satisfies CreateInfiniteQueryOptions);
			}

			const shouldAbortOnUnmount =
				currentOpts?.trpc?.abortOnUnmount ?? abortOnUnmount;
			const enabled = currentOpts?.lazy ? writable(false) : blankStore;

			const query = createInfiniteQuery(
				derived(
					[
						isInputStore ? procedureInput : blankStore,
						isOptsStore ? opts : blankStore,
						enabled,
					],
					([$input, $opts, $enabled]) => {
						const currentProcedureInputVal = !isBlank($input) ? $input : procedureInput;
						const newOpts = !isBlank($opts) ? $opts : currentOpts;
						const queryKey = getQueryKeyInternal(path, currentProcedureInputVal, 'infinite');

						return {
							...newOpts,
							initialPageParam: newOpts?.initialCursor ?? null,
							queryKey,
							queryFn: ({ pageParam, signal, direction }) => {
								let targetProc: any = trpcProxyClient;
								for (const p of path) targetProc = targetProc[p];
								const actualInput = { ...(currentProcedureInputVal ?? {}), ...(pageParam ? { cursor: pageParam } : {}), direction, };
								const trpcSpecificOptions = { ...newOpts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
								return targetProc.query(actualInput, trpcSpecificOptions);
							},
							...(!isBlank($enabled) && {
								enabled: $enabled && (newOpts?.enabled ?? true),
							}),
						} satisfies CreateInfiniteQueryOptions;
					}
				)
			);

			return currentOpts?.lazy
				? [
						query,
						async (data?: any) => {
							if (data) {
								queryClient.setQueryData(baseQueryKey, {
									pages: [await data],
									pageParams: [currentOpts?.initialCursor ?? null],
								});
							}
							(enabled as Writable<boolean>).set(true);
						},
				  ]
				: query;
		};
	},
	[Procedure.serverInfiniteQuery]: ({ path, trpcProxyClient, queryClient, abortOnUnmount }) => {
		return async (_input: any, _opts?: any) => {
			let procedureInput = _input;
			let opts = _opts;
			let shouldAbortOnUnmount = opts?.trpc?.abortOnUnmount ?? abortOnUnmount;

			const queryKey = getQueryKeyInternal(path, procedureInput, 'infinite');

			const queryFnForPrefetch = ({ pageParam, signal, direction }: { pageParam?: any, signal?: AbortSignal, direction: 'forward' | 'backward' }) => {
				let targetProc: any = trpcProxyClient;
				for (const p of path) targetProc = targetProc[p];
				const actualInput = { ...(procedureInput ?? {}), ...(pageParam ? { cursor: pageParam } : {}), direction, };
				const trpcSpecificOptions = { ...opts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
				return targetProc.query(actualInput, trpcSpecificOptions);
			};
			
			const queryForPrefetch: Omit<FetchInfiniteQueryOptions, 'initialPageParam'> & { initialPageParam?: any } = {
				queryKey,
				queryFn: queryFnForPrefetch,
				initialPageParam: opts?.initialCursor ?? null,
			};

			const cache = queryClient
				.getQueryCache()
				.find({ queryKey: queryForPrefetch.queryKey });
			const cacheNotFound = !cache?.state?.data;
			if (opts?.ssr !== false && cacheNotFound) {
				await queryClient.prefetchInfiniteQuery(queryForPrefetch as FetchInfiniteQueryOptions);
			}

			return (...args: any[]) => {
				if (args.length > 0) procedureInput = args.shift();
				if (args.length > 0) opts = args.shift();

				const isOptsStore = isSvelteStore(opts);
				const currentOpts = isOptsStore ? get(opts) : opts;
				shouldAbortOnUnmount =
					currentOpts?.trpc?.abortOnUnmount ?? abortOnUnmount;

				const staleTime = writable<number | null>(Infinity);
				onMount(() => { staleTime.set(null); });

				return createInfiniteQuery(
					derived(
						[
							isSvelteStore(procedureInput) ? procedureInput : blankStore,
							isOptsStore ? opts : blankStore,
							staleTime,
						],
						([$input, $opts, $staleTime]) => {
							const currentProcedureInputVal = !isBlank($input) ? $input : procedureInput;
							const newOpts = !isBlank($opts) ? $opts : currentOpts;
							const queryKey = getQueryKeyInternal(path, currentProcedureInputVal, 'infinite');

							return {
								...newOpts,
								initialPageParam: newOpts?.initialCursor ?? null,
								queryKey,
								queryFn: ({ pageParam, signal, direction }) => {
									let targetProc: any = trpcProxyClient;
									for (const p of path) targetProc = targetProc[p];
									const actualInput = { ...(currentProcedureInputVal ?? {}), ...(pageParam ? { cursor: pageParam } : {}), direction, };
									const trpcSpecificOptions = { ...newOpts?.trpc, ...(shouldAbortOnUnmount && { signal }) };
									return targetProc.query(actualInput, trpcSpecificOptions);
								},
								...($staleTime && { staleTime: $staleTime }),
							} satisfies CreateInfiniteQueryOptions;
						}
					)
				);
			};
		};
	},
	[Procedure.mutate]: ({ path, trpcProxyClient, queryClient }) => {
		return (opts?: any) => {
			const mutationKey = getMutationKeyInternal(path);
			// TanStack/Svelte Query v5's createMutation should handle its own default merging.
			// We remove the explicit call to queryClient.defaultMutationOptions() as it seems unavailable.
			// const defaultOpts = queryClient.defaultMutationOptions(); // This line caused errors

			const mutationSuccessOverride = (options: any) => options.originalFn();

			return createMutation({
				...opts, // Pass user-provided options directly
				mutationKey,
				mutationFn: (procedureInput) => {
					let targetProc: any = trpcProxyClient;
					for (const p of path) targetProc = targetProc[p];
					return targetProc.mutate(procedureInput, opts?.trpc);
				},
				// If defaultOpts was used for its onSuccess, we need to ensure createMutation handles this.
				// TanStack Query's createMutation typically merges options. If opts.onSuccess exists, it's used.
				// If not, createMutation would look for defaults set on QueryClient via setMutationDefaults.
				// The original onSuccess logic was: 
				// onSuccess(...args) { const originalFn = () => opts?.onSuccess?.(...args) ?? defaultOpts?.onSuccess?.(...args); ... }
				// We are now relying on createMutation to correctly layer the onSuccess handlers.
				// If an onSuccess is provided in `opts`, it will be used by createMutation.
				// If not, createMutation should use any globally configured default onSuccess.
				// The svelteQueryWrapper's own mutationSuccessOverride logic seems to be a custom layer on top.
				// For now, we simplify by not trying to manually merge defaultOpts.onSuccess here.
				onSuccess: opts?.onSuccess ? (...args) => {
					const originalFn = () => opts.onSuccess(...args);
					return mutationSuccessOverride({
						originalFn,
						queryClient,
						meta: opts?.meta ?? {},
					});
				} : undefined, // If no specific onSuccess, let createMutation use its defaults
			});
		};
	},
	[Procedure.subscribe]: ({ path, trpcProxyClient }) => {
		return (procedureInput: any, opts?: any) => {
			const enabled = opts?.enabled ?? true;
			const queryKey = hashKey(getQueryKeyInternal(path, procedureInput, 'any'));

			effect(
				() => {
					if (!enabled) return;
					let isStopped = false;

					let targetProc: any = trpcProxyClient;
					for (const p of path) targetProc = targetProc[p];
					
					const subscription = targetProc.subscribe(
						procedureInput ?? undefined,
						{
							onStarted: () => {
								if (!isStopped) opts?.onStarted?.();
							},
							onData: (data: any) => {
								if (!isStopped) opts?.onData?.(data);
							},
							onError: (err: any) => {
								if (!isStopped) opts?.onError?.(err);
							},
						}
					);
					return () => {
						isStopped = true;
						subscription.unsubscribe();
					};
				},
				() => [queryKey, enabled]
			);
		};
	},
	[Procedure.queries]: (ctx) => {
		if (ctx.path.length !== 0) return;
		return (input: (...args: any[]) => any, opts?: any) => {
			return createQueries({
				...opts,
				queries: input(createQueriesProxy(ctx)),
			});
		};
	},
	[Procedure.serverQueries]: (ctx) => {
		const { path, queryClient } = ctx;
		if (path.length !== 0) return;
		const proxy = createQueriesProxy(ctx);

		return async (
			input: (...args: any[]) => QueryObserverOptionsForCreateQueries[],
			_opts?: any
		) => {
			let opts = _opts;

			let queries = input(proxy);
			await Promise.all(
				queries.map(async (query: any) => {
					const cache = queryClient
						.getQueryCache()
						.find({ queryKey: query.queryKey });
					const cacheNotFound = !cache?.state?.data;

					if (query.ssr !== false && cacheNotFound) {
						await queryClient.prefetchQuery(query);
					}
				})
			);

			return (...args: any[]) => {
				if (args.length > 0) queries = args.shift()!(proxy, queries);
				if (args.length > 0) opts = args.shift();

				const staleTime = writable<number | null>(Infinity);
				onMount(() => { staleTime.set(null); });

				return createQueries({
					...opts,
					queries: derived(
						[isSvelteStore(queries) ? queries : blankStore, staleTime],
						([$queries, $staleTime]) => {
							const newQueries = !isBlank($queries) ? $queries : queries;
							if (!staleTime) return newQueries;
							return newQueries.map((query) => ({
								...query,
								...($staleTime && { staleTime: $staleTime }),
							}));
						}
					),
				});
			};
		};
	},
	[Procedure.utils]: (ctx) => {
		if (ctx.path.length !== 0) return;
		return () => createUtilsProxy(ctx);
	},
	[Procedure.context]: (ctx) => {
		if (ctx.path.length !== 0) return;
		return () => createUtilsProxy(ctx);
	},
};

const procedureExts = {
	[Procedure.query]: {
		opts: (opts: unknown) => opts,
	},
	[Procedure.infiniteQuery]: {
		opts: (opts: unknown) => opts,
	},
	[Procedure.mutate]: {
		opts: (opts: unknown) => opts,
	},
	[Procedure.subscribe]: {
		opts: (opts: unknown) => opts,
	},
};

type ProcedureOrRouter =
	| CreateMutationProcedure
	| CreateQueryProcedure
	| AddQueryPropTypes;

type GetParams<TProcedureOrRouter extends ProcedureOrRouter> =
	TProcedureOrRouter extends CreateQueryProcedure<infer TInput>
		? [input?: GetQueryProcedureInput<TInput>, type?: QueryType]
		: [];

/**
 * Method to extract the query key for a procedure
 * @param procedureOrRouter - procedure or any router
 * @param input - input to procedureOrRouter
 * @param type - defaults to `any`
 * @link https://trpc.io/docs/v11/getQueryKey
 */
export function getQueryKey<TProcedureOrRouter extends ProcedureOrRouter>(
	procedureOrRouter: TProcedureOrRouter,
	..._params: GetParams<TProcedureOrRouter>
) {
	const [input, type] = _params;

	// @ts-expect-error - we don't expose _def on the type layer
	const path = procedureOrRouter._def().path;
	const queryKey = getQueryKeyInternal(path, input, type ?? 'any');
	return queryKey;
}

interface SvelteQueryWrapperOptions<TRouter extends AnyRouter> {
	client: CreateTRPCClient<TRouter>;
	queryClient?: QueryClient;
	abortOnUnmount?: boolean;
}

export function svelteQueryWrapper<TRouter extends AnyRouter>({
	client,
	queryClient: _queryClient,
	abortOnUnmount,
}: SvelteQueryWrapperOptions<TRouter>) {
	type Client = typeof client;
	type RouterError = TRPCClientErrorLike<TRouter>;
	type ClientWithQuery =
		Client extends Record<any, any>
			? AddQueryPropTypes<Client, RouterError>
			: Client;

	const queryClient = _queryClient ?? useQueryClient();

	return new DeepProxy(
		{} as ClientWithQuery &
			(ClientWithQuery extends Record<any, any>
				? CreateUtilsProcedure<Client, RouterError> &
						CreateQueriesProcedure<Client, RouterError>
				: {}),
		{
			get() {
				return this.nest(() => {});
			},
			apply(_target, _thisArg, argList: [any]) {
				const key = this.path.pop() ?? '';

				if (key === '_def') return { path: this.path };

				if (hasOwn(procedures, key)) {
					return procedures[key]({
						trpcProxyClient: client as CreateTRPCClient<AnyRouter>,
						path: this.path,
						queryClient,
						abortOnUnmount,
						key,
					})(...argList);
				}

				const proc = this.path.pop() ?? '';
				if (hasOwn(procedureExts, proc) && hasOwn(procedureExts[proc], key)) {
					return procedureExts[proc][key](...argList);
				}

				console.error(`[trpc-svelte-query-adapter] Unhandled proxy path: ${this.path.join('.')}.${key}`);
			},
		}
	);
}
