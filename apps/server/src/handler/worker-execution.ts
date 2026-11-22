import { timingSafeEqual } from 'node:crypto';
import { AgentPersistenceError } from '@scova/shared/execution/agent';
import { executionPath } from '@scova/shared/execution/protocol';
import {
    RunExecutionError,
    RunFenceError,
    RUN_FAILURE_MESSAGES,
} from '@scova/shared/execution/runs';
import { isRetryableExecutionFailure } from '@scova/shared/execution/tool-failure';
import {
    decodeExecutionValue,
    encodeExecutionValue,
    executionOperationHeader,
    executionRequestLimit,
    readExecutionBody,
} from '@scova/shared/execution/wire';
import {
    InvalidExecutionRequest,
    type createExecutionService,
} from '../service/execution/protocol.ts';

export function createExecutionHandler(
    secret: string,
    service: ReturnType<typeof createExecutionService>,
) {
    const bearer = Buffer.from(`Bearer ${secret}`);
    const send = (status: number, value: object) =>
        Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
    return async (request: Request) => {
        if (request.method !== 'POST' || new URL(request.url).pathname !== executionPath)
            return send(404, { code: 'NOT_FOUND' });
        const header = Buffer.from(request.headers.get('authorization') ?? '');
        if (header.length !== bearer.length || !timingSafeEqual(header, bearer))
            return send(401, { code: 'UNAUTHORIZED' });
        const requestedAction = request.headers.get(executionOperationHeader);
        const limit = executionRequestLimit(requestedAction);
        if (
            request.headers.get('content-type') !== 'application/json' ||
            Number(request.headers.get('content-length')) > limit
        )
            return send(400, { code: 'INVALID_EXECUTION_PAYLOAD' });
        let action: string;
        let args: unknown[];
        try {
            const envelope = (await readExecutionBody(request.body, limit)) as {
                action?: unknown;
                args?: unknown;
            } | null;
            if (
                !envelope ||
                typeof envelope.action !== 'string' ||
                (requestedAction !== null && requestedAction !== envelope.action)
            )
                throw new InvalidExecutionRequest();
            action = envelope.action;
            const input = decodeExecutionValue(envelope.args);
            if (!Array.isArray(input) || input.length > 6) throw new InvalidExecutionRequest();
            args = input;
        } catch {
            return send(400, { code: 'INVALID_EXECUTION_PAYLOAD' });
        }
        try {
            const result = await service.dispatch(action, args);
            return send(200, { result: encodeExecutionValue(result) });
        } catch (error) {
            if (error instanceof InvalidExecutionRequest)
                return send(400, { code: 'INVALID_EXECUTION_PAYLOAD' });
            if (error instanceof RunFenceError)
                return send(409, { code: error.code, kind: 'fence' });
            if (error instanceof AgentPersistenceError)
                return send(422, { code: error.code, kind: 'agent' });
            if (
                error instanceof RunExecutionError &&
                Object.hasOwn(RUN_FAILURE_MESSAGES, error.code)
            )
                return send(422, { code: error.code, kind: 'run' });
            if (action === 'ready' || isRetryableExecutionFailure(error))
                return send(503, { code: 'EXECUTION_UNAVAILABLE' });
            console.error(
                'Worker execution operation failed',
                action.replace(/[^A-Za-z]/g, '').slice(0, 40),
            );
            return send(500, { code: 'EXECUTOR_FAILED' });
        }
    };
}
