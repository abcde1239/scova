import { describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';

describe('API workspace smoke', () => {
    it('exposes a documented Chinese health endpoint', async () => {
        const apiApp = createApiApp();
        const response = await apiApp.handle(new Request('http://localhost/health'));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: 'ok' });
    });

    it('exposes an OpenAPI document for later endpoint generation', async () => {
        const apiApp = createApiApp();
        const response = await apiApp.handle(new Request('http://localhost/swagger/json'));
        expect(response.status).toBe(200);
        const document = await response.json();
        expect(document.info.title).toBe('Scova API');
    });
});
