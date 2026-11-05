<template>
    <div class="settings">
        <section aria-label="当前登录账号">
            <p class="account-email">{{ session.user.value?.email }}</p>
        </section>
        <section aria-labelledby="account-defaults-title">
            <h2 id="account-defaults-title">新任务默认偏好</h2>
            <p>用于后续新建的任务草稿，不会改动已保存任务的时区、计划或配置版本。</p>
            <preferences-form />
        </section>
        <section aria-labelledby="account-agent-title">
            <h2 id="account-agent-title">Agent 与模型</h2>
            <p>管理自己的供应商、API 连接与默认模型。</p>
            <navigation-button to="/account/agent" icon="settings">Agent 配置</navigation-button>
        </section>
        <section aria-labelledby="account-local-title">
            <h2 id="account-local-title">本机外观与阅读</h2>
            <p>主题、字体与阅读字号只保存在当前浏览器。</p>
            <navigation-button to="/account/appearance"
                ><app-icon name="appearance" />外观与阅读设置</navigation-button
            >
        </section>
    </div>
</template>

<script setup lang="ts">
import NavigationButton from '@/components/common/NavigationButton.vue';
import PreferencesForm from '@/components/account/PreferencesForm.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useSession } from '@/composables/useSession';
const session = useSession();
</script>

<style scoped>
.settings {
    display: grid;
    gap: 2.5rem;
    inline-size: min(100%, 44rem);
    min-inline-size: 0;
}
section {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
}
section + section {
    padding-block-start: 2rem;
    border-block-start: 0.0625rem solid var(--scova-border);
}
h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.5;
}
p {
    margin: 0;
    overflow-wrap: anywhere;
}
.account-email {
    color: var(--scova-muted);
}
a {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: 0.5em;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
    cursor: pointer;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
