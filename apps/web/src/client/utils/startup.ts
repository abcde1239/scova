/** Keep the HTML fallback available even when importing or mounting the application fails. */
export async function startClient(root: HTMLElement, start: () => Promise<void>): Promise<void> {
    const fallback = root.querySelector<HTMLElement>('#startup-screen')?.cloneNode(true) as
        | HTMLElement
        | undefined;
    const reload = (event: Event) => {
        event.preventDefault();
        window.location.reload();
    };
    root.querySelector('[data-startup-retry]')?.addEventListener('click', reload);
    fallback?.querySelector('[data-startup-retry]')?.addEventListener('click', reload);
    try {
        await start();
    } catch (error) {
        console.error('Scova 启动失败', error);
        if (!fallback) return;
        const message = fallback.querySelector('[data-startup-message]');
        if (message) {
            message.textContent = '应用加载失败，请检查网络后重新加载';
            message.setAttribute('role', 'alert');
        }
        root.replaceChildren(fallback);
    }
}
