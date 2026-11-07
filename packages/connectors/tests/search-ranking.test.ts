import { describe, expect, it } from 'vite-plus/test';
import { rankSearchCandidates, plainSearchQuery, createSearxngSearch } from '../src/index.ts';

describe('bounded candidate selection', () => {
    it('ranks an AI Agent source beyond the first five above generic latest news and React UI', async () => {
        const sources = [
            ...Array.from({ length: 5 }, (_, i) => ({
                url: `https://news.example/${i}`,
                title: '最新ニュース',
                content: 'ニュース速報',
            })),
            {
                url: 'https://react.dev/',
                title: 'React',
                content: 'Build user interfaces with React',
            },
            {
                url: 'https://research.example/react-agent',
                title: 'ReAct: reasoning and acting AI agents',
                content: 'AI agent architecture research',
            },
        ];
        const result = await createSearxngSearch({
            http: {
                request: async () => ({
                    url: 'http://127.0.0.1:8080/search',
                    status: 200,
                    headers: {},
                    body: JSON.stringify({ results: sources }),
                }),
            },
        }).search('最新 ReAct AI Agent 架构');
        expect(result.results[0].url).toBe('https://research.example/react-agent');
        expect(result.results).toHaveLength(5);
        expect(result.coverage.receivedResults).toBe(7);
    });
    it('does not mistake React documentation for ReAct evidence or allow engine operators', () => {
        const ranked = rankSearchCandidates('ReAct AI agent architecture', [
            {
                kind: 'search_snippet',
                originalUrl: 'https://react.dev',
                url: 'https://react.dev',
                title: 'React',
                snippet: 'React documentation',
            },
            {
                kind: 'search_snippet',
                originalUrl: 'https://example.org',
                url: 'https://example.org',
                title: 'AI Agent',
                snippet: 'reasoning and acting',
            },
        ]);
        expect(ranked[0].title).toBe('AI Agent');
        expect(plainSearchQuery('!brave AI agent :all !google')).toBe('AI agent');
    });
});
