<template>
    <section class="project-settings" :aria-labelledby="`${uid}-heading`">
        <h2 :id="`${uid}-heading`">项目设定</h2>
        <p v-if="query.isPending.value" role="status">正在读取项目设定…</p>
        <div v-else-if="!draft">
            <p role="alert">项目设定暂时无法读取。</p>
            <button type="button" class="settings-button" @click="query.refetch()">重试</button>
        </div>
        <form
            v-else
            method="post"
            :aria-labelledby="`${uid}-heading`"
            :aria-busy="saving"
            @submit.prevent="save"
        >
            <div class="settings-field">
                <label :for="`${uid}-goal`">项目目标</label>
                <textarea
                    :id="`${uid}-goal`"
                    v-model="draft.goal"
                    name="goal"
                    rows="2"
                    :maxlength="PROJECT_SETTINGS_GOAL_LIMIT"
                    :disabled="saving"
                    @input="message = ''"
                />
            </div>
            <div class="settings-field">
                <label :for="`${uid}-requirements`">长期要求</label>
                <textarea
                    :id="`${uid}-requirements`"
                    v-model="draft.requirements"
                    name="requirements"
                    rows="4"
                    :maxlength="PROJECT_SETTINGS_REQUIREMENTS_LIMIT"
                    :disabled="saving"
                    @input="message = ''"
                />
            </div>
            <div class="settings-field">
                <label :for="`${uid}-sources`">常用来源</label>
                <p :id="`${uid}-sources-help`" class="settings-help">
                    每行一个 HTTP 或 HTTPS 链接，最多 {{ PROJECT_SETTINGS_SOURCE_LIMIT }} 个。
                </p>
                <textarea
                    :id="`${uid}-sources`"
                    v-model="draft.sources"
                    name="preferredSources"
                    rows="3"
                    :maxlength="
                        (PROJECT_SETTINGS_SOURCE_URL_LIMIT + 1) * PROJECT_SETTINGS_SOURCE_LIMIT
                    "
                    :aria-describedby="`${uid}-sources-help ${uid}-sources-error`"
                    :aria-invalid="sourceError ? 'true' : undefined"
                    :disabled="saving"
                    spellcheck="false"
                    @input="
                        sourceError = '';
                        message = '';
                    "
                />
                <p :id="`${uid}-sources-error`" class="scova-failure" role="alert">
                    {{ sourceError }}
                </p>
            </div>
            <div class="settings-field">
                <label :for="`${uid}-autonomy`">默认自主度</label>
                <select
                    :id="`${uid}-autonomy`"
                    v-model="draft.defaultAutonomy"
                    name="defaultAutonomy"
                    :disabled="saving"
                    @change="message = ''"
                >
                    <option value="ask">询问</option>
                    <option value="budgeted">预算内自动</option>
                    <option value="autonomous">自主</option>
                </select>
            </div>
            <div class="settings-actions">
                <button type="submit" class="settings-button" :disabled="!dirty || saving">
                    {{ saving ? '正在保存…' : '保存设定' }}
                </button>
                <p role="status">{{ message }}</p>
                <p class="scova-failure" role="alert">{{ saveError }}</p>
            </div>
        </form>
    </section>
</template>

<script setup lang="ts">
import {
    ContractValidationError,
    PatchProjectSettingsSchema,
    PROJECT_SETTINGS_GOAL_LIMIT,
    PROJECT_SETTINGS_REQUIREMENTS_LIMIT,
    PROJECT_SETTINGS_SOURCE_LIMIT,
    PROJECT_SETTINGS_SOURCE_URL_LIMIT,
    parseContract,
    type PatchProjectSettings,
    type ProjectSettings,
} from '@scova/models';
import { computed, ref, useId, watch } from 'vue';
import { patchProjectSettingsEndpoint, projectSettingsEndpoint } from '@/api/project-settings';
import {
    useSessionLifecycle,
    useSessionMutation,
    useSessionQuery,
} from '@/composable/useSessionQuery';

const props = defineProps<{ projectId: string }>();
const uid = useId();
const lifecycle = useSessionLifecycle();
const input = () => ({ params: { projectId: props.projectId } });
const key = ['project-settings'];
const query = useSessionQuery(projectSettingsEndpoint, input, key, lifecycle);
const mutation = useSessionMutation(patchProjectSettingsEndpoint, lifecycle);
const initial = ref<ProjectSettings>();
const draft = ref<{
    goal: string;
    requirements: string;
    sources: string;
    defaultAutonomy: ProjectSettings['defaultAutonomy'];
}>();
const saving = ref(false);
const message = ref('');
const sourceError = ref('');
const saveError = ref('');
let editGeneration = 0;

function load(value: ProjectSettings) {
    initial.value = value;
    draft.value = {
        goal: value.goal,
        requirements: value.requirements,
        sources: value.preferredSources.join('\n'),
        defaultAutonomy: value.defaultAutonomy,
    };
}

const dirty = computed(() => {
    const current = draft.value;
    const previous = initial.value;
    return Boolean(
        current &&
        previous &&
        (current.goal !== previous.goal ||
            current.requirements !== previous.requirements ||
            current.sources !== previous.preferredSources.join('\n') ||
            current.defaultAutonomy !== previous.defaultAutonomy),
    );
});

watch(
    () => lifecycle.queryOptions(projectSettingsEndpoint, input(), key).queryKey,
    () => {
        editGeneration++;
        initial.value = undefined;
        draft.value = undefined;
        saving.value = false;
        message.value = '';
        sourceError.value = '';
        saveError.value = '';
    },
    { flush: 'sync' },
);
watch(
    () => query.data.value?.data,
    (value) => {
        if (value?.projectId === props.projectId && !dirty.value && !saving.value) load(value);
    },
    { immediate: true },
);

async function save() {
    const previous = initial.value;
    const current = draft.value;
    if (!previous || !current || !dirty.value || saving.value) return;
    const command = input();
    const options = lifecycle.queryOptions(projectSettingsEndpoint, command, key);
    const scope = lifecycle.capture();
    const generation = editGeneration;
    const sameProject = () => scope.isCurrent() && generation === editGeneration;
    const patch: PatchProjectSettings = {};
    if (current.goal !== previous.goal) patch.goal = current.goal;
    if (current.requirements !== previous.requirements) patch.requirements = current.requirements;
    if (current.defaultAutonomy !== previous.defaultAutonomy)
        patch.defaultAutonomy = current.defaultAutonomy;
    if (current.sources !== previous.preferredSources.join('\n')) {
        patch.preferredSources = current.sources
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    }
    sourceError.value = '';
    saveError.value = '';
    message.value = '';
    try {
        parseContract(PatchProjectSettingsSchema, patch);
    } catch (error) {
        if (
            error instanceof ContractValidationError &&
            error.fieldErrors.some(({ path }) => path.startsWith('/preferredSources'))
        )
            sourceError.value = '请输入有效且不重复的 HTTP 或 HTTPS 链接。';
        else saveError.value = '请检查项目设定的内容和长度。';
        return;
    }
    saving.value = true;
    try {
        // A fetch started before the mutation must not replace its newer response.
        await lifecycle.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
        if (!sameProject()) return;
        const result = await mutation.mutateAsync({ input: { ...command, body: patch } });
        if (!scope.isCurrent()) return;
        lifecycle.queryClient.setQueryData(options.queryKey, result);
        if (!sameProject()) return;
        load(result.data);
        message.value = '设定已保存。';
    } catch {
        if (sameProject()) saveError.value = '保存失败，请重试。';
    } finally {
        if (sameProject()) saving.value = false;
    }
}
</script>

<style scoped>
.project-settings,
form,
.settings-field {
    display: grid;
    min-inline-size: 0;
}
.project-settings,
form {
    gap: 0.875rem;
}
.settings-field {
    gap: 0.375rem;
}
.project-settings h2,
.project-settings p {
    margin: 0;
}
.project-settings h2 {
    font-size: 1rem;
}
.settings-help {
    font-size: 0.8125rem;
}
.project-settings textarea,
.project-settings select,
.settings-button {
    box-sizing: border-box;
    max-inline-size: 100%;
    border: 1px solid var(--scova-border, currentColor);
    border-radius: 0.5rem;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 0.5rem;
}
.project-settings textarea {
    resize: vertical;
}
.settings-actions {
    display: grid;
    justify-items: start;
    gap: 0.375rem;
}
.settings-button {
    cursor: pointer;
}
.settings-button:disabled {
    opacity: 0.6;
    cursor: default;
}
</style>
