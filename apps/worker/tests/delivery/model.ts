import type { TaskConfig } from '@scova/models';
import {
    ConnectorError,
    type ConnectorBundle,
    type StructuredInput,
    type CallContext,
} from '@scova/connectors';
import type { LiveResearchOptions, LiveResearchPlan } from './live-options.ts';
import { deliverySupplementResponse } from './model-supplement.ts';

export function createDeliveryModel(
    options: LiveResearchOptions,
    { formats, requirements }: LiveResearchPlan,
): ConnectorBundle['model'] {
    let comparisonAttempts = 0;
    let synthesisRequests = 0;
    return {
        async generateStructured<T>(input: StructuredInput, context?: CallContext) {
            await context?.beforeAttempt?.('model');
            const supplement = deliverySupplementResponse<T>(options, input);
            if (supplement) return supplement;
            const source = input.untrustedSources?.[0] as
                | { pageId: string; text: string }
                | undefined;
            const sources = input.untrustedSources as
                | { pageId: string; text: string }[]
                | undefined;
            const claimKind = options.claimKind ?? 'fact';
            const batchContract = input.schema as {
                properties?: {
                    claims?: {
                        items: {
                            properties: {
                                outputFormat?: { enum: TaskConfig['outputFormat'][] };
                            };
                        };
                    };
                    artifacts?: {
                        items: {
                            properties: {
                                requirements: {
                                    items: { properties: { id: { enum: string[] } } };
                                };
                            };
                        };
                    };
                };
            };
            const activeFormats =
                batchContract.properties?.claims?.items.properties.outputFormat?.enum ?? formats;
            const activeIds =
                batchContract.properties?.artifacts?.items.properties.requirements.items.properties
                    .id.enum;
            if (
                options.failSynthesis &&
                Object.hasOwn((input.schema.properties ?? {}) as object, 'claims')
            ) {
                const error = new ConnectorError('invalid_response', 'DO_NOT_RENDER');
                error.modelFailure = 'schema';
                throw error;
            }
            if (Object.hasOwn((input.schema.properties ?? {}) as object, 'pages')) {
                if (options.truncatedComparison && comparisonAttempts++ === 0)
                    throw new ConnectorError('output_truncated', 'DO_NOT_RENDER');
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: {
                        pages: sources!.map((page) => ({
                            pageId: page.pageId,
                            facts:
                                claimKind === 'insufficient'
                                    ? []
                                    : [
                                          {
                                              subject: '公开公告',
                                              predicate: '公告内容',
                                              value: options.factValue ?? page.text,
                                              quote: options.badComparisonQuote
                                                  ? 'UNLOCATABLE_MODEL_QUOTE'
                                                  : page.text,
                                              relevance: 'relevant',
                                              importance: options.importance ?? 'important',
                                              ...(options.nullableRelation
                                                  ? { relation: null }
                                                  : {}),
                                          },
                                      ],
                        })),
                    } as T,
                };
            }
            const delayed = !!options.delayedBindings && !!source && ++synthesisRequests <= 4;
            return {
                mode: 'live',
                usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                data: (source
                    ? {
                          ...(Object.hasOwn(input.schema.properties ?? {}, 'fieldChecks')
                              ? {
                                    fieldChecks: (activeIds ?? requirements.map((r) => r.id)).map(
                                        (requirementId) => ({
                                            requirementId,
                                            status: delayed
                                                ? 'binding_missing'
                                                : claimKind === 'conflict'
                                                  ? 'conflict'
                                                  : claimKind === 'insufficient'
                                                    ? 'evidence_missing'
                                                    : options.badClaimQuote
                                                      ? 'binding_missing'
                                                      : 'supported',
                                            query:
                                                claimKind === 'insufficient'
                                                    ? '公共公告 申请核对方法'
                                                    : '',
                                            reason: '按受控命题与原文核对',
                                        }),
                                    ),
                                }
                              : {}),
                          ...(options.evidenceLinks
                              ? {
                                    evidenceLinks: [
                                        {
                                            pageId: source.pageId,
                                            questionId: 'q1',
                                            quote: source.text,
                                            reason: '公告正文支持另一冻结问题。',
                                        },
                                    ],
                                }
                              : {}),
                          ...(options.structuredArtifacts === false
                              ? {}
                              : {
                                    artifacts: activeFormats.map((format) => ({
                                        format,
                                        document:
                                            options.editorialDocument &&
                                            ['brief', 'research_report'].includes(format)
                                                ? {
                                                      version: 1,
                                                      sections: [
                                                          {
                                                              id: 'findings',
                                                              title: '关键发现',
                                                              role: 'key_findings',
                                                              claimIndexes: [0],
                                                          },
                                                      ],
                                                  }
                                                : null,
                                        requirements: requirements
                                            .filter(
                                                (r) =>
                                                    r.format === format &&
                                                    (!activeIds || activeIds.includes(r.id)),
                                            )
                                            .map((r) => ({
                                                id: r.id,
                                                text: delayed
                                                    ? ''
                                                    : options.outputFormats
                                                      ? `${format}独立归纳：申请期限需要结合原公告确认。`
                                                      : claimKind === 'fact'
                                                        ? source.text
                                                        : {
                                                              inference: '基于原文推断还需继续查证',
                                                              conflict:
                                                                  '两处来源的截止日期存在冲突',
                                                              insufficient: '当前结论证据不足',
                                                          }[claimKind],
                                                claimIndexes: delayed ? [] : [0],
                                            })),
                                    })),
                                }),
                          claims: activeFormats.map((format) => ({
                              outputFormat: format,
                              kind: claimKind,
                              assessment: {
                                  ...((input.schema as any).properties.claims.items.properties
                                      .assessment?.properties.gapKind
                                      ? { gapKind: 'none' }
                                      : {}),
                                  relevance: 'direct',
                                  support: 'direct',
                                  role: 'answer',
                                  sourceRelation: 'unknown',
                                  reason: '受控原文直接回答测试问题',
                                  conditions: options.condition ?? '',
                                  gap: '',
                              },
                              text: options.outputFormats
                                  ? `${format}独立归纳：申请期限需要结合原公告确认。`
                                  : claimKind === 'fact'
                                    ? source.text
                                    : {
                                          inference: '基于原文推断还需继续查证',
                                          conflict: '两处来源的截止日期存在冲突',
                                          insufficient: '当前结论证据不足',
                                      }[claimKind],
                              questionIds: ['q0', 'q1'],
                              citations:
                                  claimKind === 'insufficient'
                                      ? []
                                      : (claimKind === 'conflict' ? sources! : [source]).map(
                                            (entry) => ({
                                                pageId: entry.pageId,
                                                quote: options.badClaimQuote
                                                    ? 'UNLOCATABLE_CLAIM_QUOTE'
                                                    : entry.text,
                                            }),
                                        ),
                          })),
                      }
                    : {
                          queries: [
                              {
                                  query: '公共公告',
                                  questionIds: options.evidenceLinks ? ['q0'] : ['q0', 'q1'],
                              },
                          ],
                          ...(options.evidenceLinks
                              ? {
                                    knowledgePlan: [
                                        {
                                            questionId: 'q0',
                                            candidate: '申请可能有截止时间',
                                            verify: '查阅实际公告而非猜测日期',
                                        },
                                    ],
                                }
                              : {}),
                          ...(options.structuredArtifacts === false ? {} : { requirements }),
                      }) as T,
            };
        },
    };
}
