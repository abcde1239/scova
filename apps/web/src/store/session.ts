import { defineStore } from 'pinia';
import { shallowRef, ref } from 'vue';
import type { User } from '@scova/models';

/** 只存客户端会话摘要；CSRF 保留在生命周期闭包中，不持久化凭据。 */
export const useSessionStore = defineStore('session', () => {
    const epoch = ref(0);
    const user = shallowRef<User | null>(null);

    function advance() {
        epoch.value += 1;
        user.value = null;
    }

    function install(nextUser: User | null) {
        user.value = nextUser;
    }

    return { epoch, user, advance, install };
});
