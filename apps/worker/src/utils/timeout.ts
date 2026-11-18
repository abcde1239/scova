/** Bounded shutdown waits; late task settlement remains observed by Promise.race. */
export async function within<T>(
    task: Promise<T>,
    milliseconds: number,
    message = '后台操作超时',
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            task,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
