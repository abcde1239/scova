import { selectedOutputFormats } from '@scova/models';
import { runResearchAgent } from '../src/research/graph.ts';
import type { AgentContext, AgentDependencies } from '../src/types.ts';

/** Supply the current wire contract for older scenario fixtures that test other behavior. */
export function runStructuredFixture(context: AgentContext, deps: AgentDependencies) {
    const formats = selectedOutputFormats(context.config);
    const questions = [
        ...new Set([context.config.goal || context.config.topic, ...context.config.focusPoints]),
    ];
    const requirements = formats.flatMap((format) =>
        questions.map((field, index) => ({
            id: `${format}-q${index}`,
            format,
            questionIds: [`q${index}`],
            object: '',
            field,
            required: true,
        })),
    );
    const model = deps.tools.model;
    return runResearchAgent(context, {
        ...deps,
        tools: {
            ...deps.tools,
            model: async (key, input) => {
                const response = await model(key, input);
                if (!response.data || typeof response.data !== 'object') return response;
                const data = response.data as Record<string, unknown>;
                if (key.startsWith('plan') && !data.requirements) data.requirements = requirements;
                const batchFormats = (
                    input.schema as {
                        properties?: {
                            claims?: {
                                items?: { properties?: { outputFormat?: { enum?: string[] } } };
                            };
                        };
                    }
                ).properties?.claims?.items?.properties?.outputFormat?.enum;
                if (
                    key.startsWith('synthesize') &&
                    batchFormats?.length === 1 &&
                    Array.isArray(data.claims)
                ) {
                    data.claims = data.claims
                        .filter(
                            (raw) => !raw.outputFormat || batchFormats.includes(raw.outputFormat),
                        )
                        .map((raw) => ({
                            ...raw,
                            outputFormat: raw.outputFormat ?? batchFormats[0],
                        }));
                }
                if (key.startsWith('synthesize') && !data.artifacts && Array.isArray(data.claims)) {
                    const claims = data.claims as {
                        outputFormat?: string;
                        text: string;
                        questionIds: string[];
                    }[];
                    data.artifacts = formats
                        .filter((format) => !batchFormats || batchFormats.includes(format))
                        .map((format) => ({
                            format,
                            document: null,
                            requirements: requirements
                                .filter((r) => r.format === format)
                                .map((r) => {
                                    const index = claims.findIndex(
                                        (c) =>
                                            (c.outputFormat ?? formats[0]) === format &&
                                            r.questionIds.every((id) => c.questionIds.includes(id)),
                                    );
                                    return {
                                        id: r.id,
                                        text: index < 0 ? '' : claims[index]!.text,
                                        claimIndexes: index < 0 ? [] : [index],
                                    };
                                }),
                        }));
                }
                return response;
            },
        },
    });
}
