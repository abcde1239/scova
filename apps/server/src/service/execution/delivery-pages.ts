import { isDeepStrictEqual } from 'node:util';
import type { AgentPage, AgentPageRef } from '@scova/agent-core';
import type { ToolCall } from '@scova/db';
import { invalid, output } from '../../utils/execution/delivery.ts';

/** Rehydrate only the exact immutable successful read operation named by a checkpoint reference. */
export function deliveryPages(refs: AgentPageRef[], successful: ToolCall[]): AgentPage[] {
    return refs.map((ref) => {
        const { id, questionIds, text, ...metadata } = ref as AgentPage;
        const call = successful.find(
            (c) =>
                c.tool === 'read' &&
                c.operationKey.startsWith(`${id}:`) &&
                (() => {
                    const { text: _body, ...saved } = output(c) as AgentPage;
                    return (
                        isDeepStrictEqual(saved, metadata) &&
                        (text === undefined || text === (output(c) as AgentPage).text)
                    );
                })(),
        );
        if (!call) return invalid();
        return { ...(output(call) as AgentPage), id, questionIds };
    });
}
