<template>
    <div class="avatar-settings" :aria-busy="pending ? 'true' : undefined">
        <account-avatar
            class="profile-avatar"
            :email="user?.email"
            :version="user?.avatarVersion"
            :preview="preview"
        />
        <p class="account-email">{{ user?.email }}</p>
        <div class="avatar-details">
            <p class="help">JPEG、PNG、GIF 或 WebP，最大5 MiB。居中裁成方形，动图使用第一帧。</p>
            <p v-if="query.isPending.value" role="status">正在读取头像设置…</p>
            <p v-else-if="query.isError.value" class="scova-failure" role="alert">
                头像设置暂时无法读取，请刷新重试。
            </p>
            <p v-else-if="!query.data.value?.data.available" class="help">
                当前部署尚未启用头像上传。
            </p>
            <input
                ref="input"
                class="file-input"
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                aria-label="选择头像文件"
                :disabled="pending || !query.data.value?.data.available"
                @change="choose"
            />
            <div class="avatar-actions">
                <action-button
                    :disabled="pending || !query.data.value?.data.available"
                    @click="input?.click()"
                    >选择图片</action-button
                >
                <action-button v-if="file" type="primary" :busy="pending" @click="upload"
                    >上传头像</action-button
                >
                <action-button v-if="file" :disabled="pending" @click="cancel"
                    >取消选择</action-button
                >
                <action-button
                    v-if="user?.avatarVersion && !file"
                    :disabled="pending"
                    @click="remove"
                    >移除头像</action-button
                >
                <action-button quaternary :disabled="pending" @click="refresh"
                    >刷新头像</action-button
                >
            </div>
            <p v-if="file" class="help">已选择 {{ file.name }}，上传后生效。</p>
            <p
                v-if="message"
                :class="{ 'scova-failure': !success }"
                :role="success ? 'status' : 'alert'"
            >
                {{ message }}
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import AccountAvatar from '@/components/account/AccountAvatar.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import { useAvatar } from '@/composables/useAvatar';
const {
    query,
    file,
    preview,
    pending,
    message,
    success,
    user,
    select,
    cancel,
    upload,
    remove,
    refresh,
} = useAvatar();
const input = ref<HTMLInputElement>();
function choose(event: Event) {
    const target = event.target as HTMLInputElement;
    select(target.files?.[0]);
    target.value = '';
}
</script>

<style scoped>
.avatar-settings {
    display: grid;
    grid-template-columns: 5rem minmax(0, 1fr);
    align-items: flex-start;
    gap: 0.75rem 1.25rem;
    min-inline-size: 0;
}
.profile-avatar {
    grid-row: 1 / span 2;
    inline-size: 5rem;
    block-size: 5rem;
    font-size: 2rem;
}
.avatar-details {
    grid-column: 2;
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
}
.account-email {
    grid-column: 2;
    min-inline-size: 0;
}
.avatar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}
p {
    margin: 0;
    overflow-wrap: anywhere;
}
.help,
.account-email {
    color: var(--scova-muted);
}
.file-input {
    display: none;
}
@media (max-width: 35.999rem) {
    .avatar-settings {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 1.25rem;
    }
    .account-email {
        flex: 1 1 12rem;
    }
    .avatar-details {
        flex: 1 0 100%;
    }
}
</style>
