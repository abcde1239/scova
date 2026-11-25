import { defineStore } from 'pinia';
import { ref } from 'vue';

const storageKey = 'scova.sidebar.collapsed';

function readCollapsedPreference() {
    try {
        return typeof window !== 'undefined' && window.localStorage.getItem(storageKey) === 'true';
    } catch {
        return false;
    }
}

export const useSidebarStore = defineStore('sidebar', () => {
    const collapsed = ref(readCollapsedPreference());

    function toggle() {
        collapsed.value = !collapsed.value;
        try {
            window.localStorage.setItem(storageKey, String(collapsed.value));
        } catch {
            // The sidebar still works when browser storage is unavailable.
        }
    }

    return { collapsed, toggle };
});
