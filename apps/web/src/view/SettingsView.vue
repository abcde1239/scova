<template>
    <div class="settings layout-grid gap-10 w-[min(100%,_44rem)]">
        <section
            class="layout-grid gap-5 [section_+_&:is(section)]:(pt-8 [border-top:0.0625rem_solid_var(--scova-border)])"
            aria-label="当前登录账号"
        >
            <avatar-settings />
        </section>
        <section
            class="layout-grid gap-5 [section_+_&:is(section)]:(pt-8 [border-top:0.0625rem_solid_var(--scova-border)])"
            aria-labelledby="account-defaults-title"
        >
            <h2 class="text-[1.25rem] font-semibold leading-[1.5] m-0" id="account-defaults-title">
                新任务默认偏好
            </h2>
            <p class="break-anywhere m-0">
                用于后续新建的任务草稿，不会改动已保存任务的时区、计划或配置版本。
            </p>
            <preferences-form />
        </section>
        <section
            class="layout-grid gap-5 [section_+_&:is(section)]:(pt-8 [border-top:0.0625rem_solid_var(--scova-border)])"
            aria-labelledby="account-agent-title"
        >
            <h2 class="text-[1.25rem] font-semibold leading-[1.5] m-0" id="account-agent-title">
                Agent 与模型
            </h2>
            <p class="break-anywhere m-0">管理自己的供应商、API 连接与默认模型。</p>
            <navigation-button to="/account/agent" icon="settings">Agent 配置</navigation-button>
        </section>
        <section
            class="layout-grid gap-5 [section_+_&:is(section)]:(pt-8 [border-top:0.0625rem_solid_var(--scova-border)])"
            aria-labelledby="account-local-title"
        >
            <h2 class="text-[1.25rem] font-semibold leading-[1.5] m-0" id="account-local-title">
                本机外观与阅读
            </h2>
            <p class="break-anywhere m-0">主题、字体与阅读字号只保存在当前浏览器。</p>
            <navigation-button to="/account/appearance"
                ><app-icon name="appearance" />外观与阅读设置</navigation-button
            >
        </section>
    </div>
</template>

<script setup lang="ts">
import NavigationButton from '@/component/common/NavigationButton.vue';
import PreferencesForm from '@/component/account/PreferencesForm.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import AvatarSettings from '@/component/account/AvatarSettings.vue';
</script>
