import { describe, expect, it } from 'vite-plus/test';
import { estimateModelInputTokens } from '@scova/connectors';
import { evidenceExcerpt, fitSources } from '../src/model/input.ts';
import type { AgentPage } from '../src/types.ts';
import { comparisonSourceCoverage } from '../src/report/comparison/extraction.ts';
import { compoundApiBody } from './fixtures/api-anchor-source.ts';

describe('model source coverage', () => {
    const input = { prompt: 'summarize', schema: {}, maxInputTokens: 3000, maxOutputTokens: 1000 };
    const pages = ['a', 'b'].map(
        (id) =>
            ({
                id,
                url: `https://example.com/${id}`,
                questionIds: ['q0'],
                text: `开头${'😀中间。'.repeat(2000)}结尾`,
            }) as AgentPage,
    );
    it('fits all sources into remaining input, preserving separate exact head/middle/tail excerpts', () => {
        const result = fitSources(input, pages);
        expect(result.clipped).toBe(true);
        expect(estimateModelInputTokens(result.input)).toBeLessThanOrEqual(input.maxInputTokens);
        const sources = result.input.untrustedSources as { pageId: string; excerpts: string[] }[];
        expect(sources).toHaveLength(2);
        for (const [index, source] of sources.entries()) {
            expect(source.excerpts[0].startsWith('开头')).toBe(true);
            expect(source.excerpts.at(-1)!.endsWith('结尾')).toBe(true);
            for (const excerpt of source.excerpts) {
                expect(pages[index].text).toContain(excerpt);
                expect(excerpt.isWellFormed()).toBe(true);
            }
        }
    });
    it('rejects input that cannot fit metadata instead of silently dropping pages', () => {
        expect(() => fitSources({ ...input, maxInputTokens: 10 }, pages)).toThrow(/预算不足/);
    });
    it('finds a task field beyond the table of contents and retains adjacent material conditions', () => {
        const context = 'Unrelated historical background occupies this paragraph.\n\n';
        const heading = 'proxy_read_timeout\n\n';
        const answer = 'Sets a timeout for reading a response from the proxied server.\n\n';
        const condition =
            'The timeout is set only between two successive read operations, not for the transmission of the whole response.\n\n';
        const body =
            '# Contents\n\nproxy_read_timeout\ndatetime.now\nonWatcherCleanup\n\n' +
            context.repeat(350) +
            heading +
            answer +
            condition +
            context.repeat(1050);
        const source = { ...pages[0]!, text: body };
        const baseline = fitSources(input, [source]);
        expect(JSON.stringify(baseline.input.untrustedSources)).not.toContain(condition.trim());
        const result = fitSources(input, [source], true, ['proxy_read_timeout']);
        const supplied = JSON.stringify(result.input.untrustedSources);
        expect(supplied).toContain(answer.trim());
        expect(supplied).toContain(condition.trim());
        expect(result.clipped).toBe(true);
        expect(estimateModelInputTokens(result.input)).toBeLessThanOrEqual(input.maxInputTokens);
        expect(comparisonSourceCoverage(result.input).pages).toEqual([
            { pageId: source.id, clipped: true },
        ]);
        const projected = result.input.untrustedSources as {
            excerpts: string[];
            excerptRanges: { start: number; end: number }[];
            offsetUnit: string;
        }[];
        for (const item of projected) {
            expect(item.offsetUnit).toBe('utf16');
            item.excerptRanges.forEach((range, index) =>
                expect(body.slice(range.start, range.end)).toBe(item.excerpts[index]),
            );
        }
    });
    it('keeps distinct requested fields with exact Unicode offsets under one unchanged budget', () => {
        const background = '普通背景段落，不包含所需接口。\n\n';
        const first = 'alpha_field returns the first requested value.\n\n';
        const second = 'beta_field returns the second requested value.\n\n';
        const body =
            '😀'.repeat(30) +
            '\n\n' +
            background.repeat(900) +
            first +
            background.repeat(1800) +
            second +
            background.repeat(900);
        const result = fitSources(
            { ...input, maxInputTokens: 4500 },
            [{ ...pages[0]!, text: body }],
            false,
            ['alpha_field', 'beta_field'],
        );
        const source = result.input.untrustedSources![0] as {
            excerpts: string[];
            excerptRanges: { start: number; end: number }[];
        };
        expect(source.excerpts.join('')).toContain(first.trim());
        expect(source.excerpts.join('')).toContain(second.trim());
        for (const [index, range] of source.excerptRanges.entries()) {
            expect(body.slice(range.start, range.end)).toBe(source.excerpts[index]);
            expect(source.excerpts[index]!.isWellFormed()).toBe(true);
        }
        expect(result.clipped).toBe(true);
        expect(estimateModelInputTokens(result.input)).toBeLessThanOrEqual(4500);
    });
    it('prioritizes a compound API definition over sibling examples mentioning the same API', () => {
        const result = fitSources(
            { ...input, maxInputTokens: 6000, maxOutputTokens: 2000 },
            [{ ...pages[0]!, text: compoundApiBody }],
            false,
            ['datetime.now timezone tz aware naive'],
        );
        const source = result.input.untrustedSources![0] as {
            excerpts: string[];
            excerptRanges: { start: number; end: number }[];
        };
        expect(
            source.excerpts.some((excerpt) =>
                excerpt.includes('Return the current local date and time.'),
            ),
        ).toBe(true);
        expect(
            source.excerpts.some((excerpt) =>
                excerpt.includes('If optional argument tz is None or not specified'),
            ),
        ).toBe(true);
        expect(
            source.excerpts.some((excerpt) =>
                excerpt.includes('If tz is not None, it must be an instance of a tzinfo subclass'),
            ),
        ).toBe(true);
        source.excerptRanges.forEach((range, index) =>
            expect(compoundApiBody.slice(range.start, range.end)).toBe(source.excerpts[index]),
        );
        expect(estimateModelInputTokens(result.input)).toBeLessThanOrEqual(6000);
        expect(result.clipped).toBe(true);
        expect(comparisonSourceCoverage(result.input).pages[0]?.clipped).toBe(true);
    });
    it.each([false, true])(
        'includes the current soft output target before fitting sources (comparison=%s)',
        (comparison) => {
            const result = fitSources(
                { ...input, maxInputTokens: 6000, maxOutputTokens: 7200 },
                pages,
                comparison,
            );
            expect(result.input.prompt).toContain('hard cap 7200 tokens');
            expect(result.input.prompt).toContain('Aim below 4320 tokens');
            expect(result.input.prompt).toContain('not a quota');
            expect(result.input.prompt).toContain('complete JSON');
            expect(result.input.prompt).toContain('preserving material conditions');
            expect(estimateModelInputTokens(result.input)).toBeLessThanOrEqual(6000);
            expect(result.input.maxOutputTokens).toBe(7200);
            expect(input.prompt).toBe('summarize');
        },
    );
    it('comparison includes content past 4000 characters when its larger budget fits', () => {
        const body = 'source '.repeat(6000) + 'Final important finding.';
        const result = fitSources(
            { ...input, maxInputTokens: 100000 },
            [{ ...pages[0], text: body }],
            true,
        );
        expect(result.clipped).toBe(false);
        expect(result.input.untrustedSources).toEqual([
            { pageId: 'a', url: 'https://example.com/a', questionIds: ['q0'], text: body },
        ]);
    });
    it('does not expand the requested output target to fill a large report allowance', () => {
        const result = fitSources({ ...input, maxInputTokens: 10000, maxOutputTokens: 64000 }, []);
        expect(result.input.prompt).toContain('Aim below 8192 tokens');
        expect(result.input.maxOutputTokens).toBe(64000);
    });
    it('ends evidence at a sentence boundary and preserves Unicode when none exists', () => {
        expect(evidenceExcerpt(`完整句子。${'后续'.repeat(400)}`)).toBe('完整句子。');
        const result = evidenceExcerpt('😀'.repeat(600));
        expect(Array.from(result)).toHaveLength(500);
        expect(result.isWellFormed()).toBe(true);
    });
});
