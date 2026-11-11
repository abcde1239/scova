import { ConnectorError } from './types.ts';

const capacityFailures = new Set(['网页节点数超过提取限制', '表格展开结构超过提取限制']);

/** Rendering cannot recover a document already exceeding extraction safety limits. */
export function isExtractionCapacityError(error: unknown): boolean {
    return (
        error instanceof ConnectorError &&
        error.code === 'extraction_failed' &&
        capacityFailures.has(error.message)
    );
}
