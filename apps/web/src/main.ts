import { startClient } from '@/utils/startup';

void startClient(document.getElementById('app')!, async () => {
    // Load the application and its CSS inside the recovery boundary.
    const { mountApplication } = await import('@/bootstrap');
    await mountApplication();
});
