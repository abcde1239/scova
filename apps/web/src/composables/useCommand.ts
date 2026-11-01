import { ref } from 'vue';

/** 同一用户动作在途只派发一次；不负责网络重试或缓存。 */
export function useCommand() {
    const pending = ref(false);
    async function run<T>(command: () => Promise<T>): Promise<T | undefined> {
        if (pending.value) return;
        pending.value = true;
        try {
            return await command();
        } finally {
            pending.value = false;
        }
    }
    return { pending, run };
}
