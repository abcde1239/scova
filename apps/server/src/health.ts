import { operations } from '@/handler/operations.ts';

try {
    const response = await fetch('http://127.0.0.1:3000/health', {
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('API 未响应');
    await operations(['ready']);
} catch {
    process.exitCode = 1;
}
