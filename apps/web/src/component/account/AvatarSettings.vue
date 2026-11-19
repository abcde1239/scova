<template>
    <div
        class="avatar-settings layout-grid grid-cols-[5rem_minmax(0,_1fr)] items-start gap-[0.75rem_1.25rem] [@media(max-width:_35.999rem)]:(flex items-center flex-wrap gap-5)"
        :aria-busy="pending ? 'true' : undefined"
    >
        <account-avatar
            class="profile-avatar [&&]:([grid-row:1_/_span_2] w-[5rem] h-[5rem] text-[2rem])"
            :email="user?.email"
            :version="user?.avatarVersion"
            :preview="preview"
        />
        <p
            class="account-email break-anywhere [grid-column:2] min-w-0 text-muted m-0 [@media(max-width:_35.999rem)]:[flex:1_1_12rem]"
        >
            {{ user?.email }}
        </p>
        <div
            class="avatar-details [grid-column:2] layout-grid gap-3 [@media(max-width:_35.999rem)]:[flex:1_0_100%]"
        >
            <p class="help break-anywhere text-muted m-0">
                JPEG、PNG、GIF 或 WebP，最大5 MiB。居中裁成方形，动图使用第一帧。
            </p>
            <p class="break-anywhere m-0" v-if="query.isPending.value" role="status">
                正在读取头像设置…
            </p>
            <p
                v-else-if="query.isError.value"
                class="scova-failure break-anywhere m-0"
                role="alert"
            >
                头像设置暂时无法读取，请刷新重试。
            </p>
            <p
                v-else-if="!query.data.value?.data.available"
                class="help break-anywhere text-muted m-0"
            >
                当前部署尚未启用头像上传。
            </p>
            <input
                ref="input"
                class="file-input hidden"
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                aria-label="选择头像文件"
                :disabled="pending || !query.data.value?.data.available"
                @change="choose"
            />
            <div class="avatar-actions flex flex-wrap gap-2">
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
            <p v-if="file" class="help break-anywhere text-muted m-0">
                已选择 {{ file.name }}，上传后生效。
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import AccountAvatar from '@/component/account/AccountAvatar.vue';
import ActionButton from '@/component/common/ActionButton.vue';
import { useAvatar } from '@/composable/useAvatar';
import { useActionNotification } from '@/composable/useActionNotification';
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
useActionNotification().watch(message, () => (success.value ? 'success' : 'error'));
const input = ref<HTMLInputElement>();
function choose(event: Event) {
    const target = event.target as HTMLInputElement;
    select(target.files?.[0]);
    target.value = '';
}
</script>
