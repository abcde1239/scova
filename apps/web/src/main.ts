import { startClient } from '@/client/utils/startup';

void startClient(document.getElementById('app')!, async () => {
    const { mountApplication } = await import('@/bootstrap');
    await mountApplication();
});
