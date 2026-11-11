import { describe, expect, it } from 'vite-plus/test';
import { JSDOM } from 'jsdom';
import { pageHasPendingData } from '../src/page-data-readiness.ts';
import { checkPageQuality } from '../src/page-quality.ts';

function assess(body: string) {
    const dom = new JSDOM(body);
    try {
        return {
            pending: pageHasPendingData(dom.window.document),
            limitations: checkPageQuality(dom.window.document, body),
        };
    } finally {
        dom.window.close();
    }
}

describe('unfinished dynamic values in an otherwise readable page', () => {
    it.each([
        '<span data-json-replace="#[fee]/passport/en"><strong>[Error loading fee. <a href="/fees">Check the fee list</a>.]</strong></span>',
        '<div role="status">Failed to retrieve the current price.</div>',
        '<output>Unable to load the current balance.</output>',
        '<div class="load-error">数据加载失败，请稍后重试。</div>',
    ])('does not certify a failed dynamic value as complete data: %s', (field) => {
        expect(
            assess(
                `<main><h1>Service details</h1><p>Eligibility and application conditions remain publicly available.</p>${field}</main>`,
            ),
        ).toEqual({ pending: true, limitations: ['render_timeout'] });
    });
    it('accepts a resolved value without treating its remaining binding attribute as a failure', () => {
        expect(
            assess(
                '<main><h1>Fees</h1><span data-json-replace="#[fee]/passport/en">$120</span></main>',
            ),
        ).toEqual({ pending: false, limitations: [] });
    });
    it.each([
        '<p>The article explains the message Error loading fee and suggests diagnostics.</p>',
        '<pre><code data-bind="example">Error loading fee.</code></pre>',
        '<blockquote><span role="status">Error loading data.</span></blockquote>',
        '<aside><span data-json-replace="example">Error loading comments.</span></aside>',
        '<div hidden><span data-json-replace="example">Error loading data.</span></div>',
        '<div style="display:none"><span data-json-replace="example">Error loading data.</span></div>',
    ])(
        'does not mistake examples or auxiliary/hidden states for missing primary data: %s',
        (fragment) => {
            expect(
                assess(
                    `<main><article><p>Published evidence is already available.</p>${fragment}</article></main>`,
                ),
            ).toEqual({ pending: false, limitations: [] });
        },
    );
});
