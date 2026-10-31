import { isCancelledError, MutationCache, QueryCache, QueryClient } from '@tanstack/vue-query';
import { isRequestCancelled } from 'requestlane';
import { ApiRequestError } from '@/api/errors';

export function shouldReportQueryError(error: unknown) {
    return (
        !isCancelledError(error) &&
        !isRequestCancelled(error) &&
        !(error instanceof ApiRequestError && error.kind === 'cancelled')
    );
}

export function createQueryClient(onError?: (error: unknown) => void) {
    const report = (error: unknown) => {
        if (shouldReportQueryError(error)) onError?.(error);
    };
    return new QueryClient({
        queryCache: new QueryCache({ onError: report }),
        mutationCache: new MutationCache({ onError: report }),
        defaultOptions: {
            queries: {
                retry: false,
                staleTime: 30_000,
                refetchOnWindowFocus: false,
                refetchOnReconnect: false,
            },
            mutations: { retry: false },
        },
    });
}
