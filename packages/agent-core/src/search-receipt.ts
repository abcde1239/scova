import type { SearchResponse } from '@scova/connectors';
import { isDeepStrictEqual } from 'node:util';

/** Full provider bodies remain in the immutable tool ledger and enter evidence via read. */
export function searchCheckpointResponse(response: SearchResponse): SearchResponse {
    return {
        ...response,
        results: response.results.map(({ page: _page, ...candidate }) => candidate),
    };
}

export function searchReceiptMatchesOutput(receipt: unknown, output: unknown): boolean {
    // Older checkpoints may still contain the complete provider response.
    if (isDeepStrictEqual(receipt, output)) return true;
    if (
        !output ||
        typeof output !== 'object' ||
        !('results' in output) ||
        !Array.isArray(output.results) ||
        output.results.some(
            (result) => !result || typeof result !== 'object' || Array.isArray(result),
        )
    )
        return false;
    // Only the ledger projection is reduced: a modified body in a receipt must still fail.
    return isDeepStrictEqual(receipt, searchCheckpointResponse(output as SearchResponse));
}
