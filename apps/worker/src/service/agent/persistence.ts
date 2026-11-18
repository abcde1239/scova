import { ConnectorError } from '@scova/connectors';
import type { RunExecutionContext } from '@/service/runs.ts';
import { type AgentSessionOptions } from '@/service/agent/session.ts';

export function createSessionPersistence(
    rawRepository: AgentSessionOptions['repository'],
    rawSaver: AgentSessionOptions['saver'],
    context: RunExecutionContext,
) {
    const pending = new Set<Promise<unknown>>();
    function trackDomain<T>(operation: () => Promise<T>, allowDeadline = false): Promise<T> {
        const assertControl = () => {
            if (
                context.controlSignal?.aborted ||
                (context.signal.aborted && !(allowDeadline && context.signal.reason === 'deadline'))
            )
                throw new ConnectorError('aborted', '执行已停止');
        };
        try {
            assertControl();
        } catch (error) {
            return Promise.reject(error);
        }
        const task = Promise.resolve().then(() => {
            assertControl();
            return operation();
        });
        pending.add(task);
        void task.then(
            () => pending.delete(task),
            () => pending.delete(task),
        );
        return task;
    }
    // Track short persistence work separately from possibly uncooperative external providers.
    const repository = new Proxy(rawRepository, {
        get(target, property) {
            const method = Reflect.get(target, property);
            if (typeof method !== 'function') return method;
            return (...args: unknown[]) =>
                trackDomain(
                    async () => Reflect.apply(method, target, args),
                    [
                        'readPages',
                        'comparison',
                        'readAuthorizedCheckpoint',
                        'readCheckpointPages',
                    ].includes(String(property)) &&
                        (
                            args[property === 'readCheckpointPages' ? 1 : 0] as
                                | { allowDeadline?: boolean }
                                | undefined
                        )?.allowDeadline === true,
                );
        },
    });
    const saver = new Proxy(rawSaver, {
        get(target, property) {
            const method = Reflect.get(target, property);
            if (typeof method !== 'function') return method;
            if (['getTuple', 'put', 'putWrites'].includes(String(property)))
                return (...args: unknown[]) =>
                    trackDomain(async () => Reflect.apply(method, target, args));
            return method.bind(target);
        },
    });

    return { repository, saver, trackDomain, drain: () => Promise.allSettled(pending) };
}
