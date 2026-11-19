<template>
    <div
        ref="root"
        class="date-time-input min-w-0 w-full [&.date-time-input_.n-date-picker]:(w-full min-w-0) [&.date-time-input_.n-time-picker]:(w-full min-w-0) [&.date-time-input_.n-input]:![--n-font-size:1rem]"
    >
        <n-config-provider
            abstract
            :locale="zhCN"
            :date-locale="dateZhCN"
            :theme-overrides="pickerTheme"
        >
            <n-date-picker
                v-if="kind === 'date'"
                :value="timestamp"
                type="datetime"
                format="yyyy-MM-dd HH:mm:ss.SSS"
                time-picker-format="HH:mm:ss"
                :disabled="disabled"
                :status="error ? 'error' : undefined"
                clearable
                update-value-on-close
                to=".scova-theme"
                @update:value="updateDate"
            />
            <n-time-picker
                v-else
                :formatted-value="model || null"
                format="HH:mm"
                value-format="HH:mm"
                :disabled="disabled"
                :status="error ? 'error' : undefined"
                clearable
                to=".scova-theme"
                @update:formatted-value="model = $event ?? ''"
            />
        </n-config-provider>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUpdated, ref } from 'vue';
import {
    NConfigProvider,
    NDatePicker,
    NTimePicker,
    zhCN,
    dateZhCN,
    type GlobalThemeOverrides,
} from 'naive-ui';
// Naive's default calendar cells use px; scale their geometry with the shared rem typography.
const pickerTheme: GlobalThemeOverrides = {
    DatePicker: {
        itemSize: '2rem',
        itemCellWidth: '2.375rem',
        itemCellHeight: '2.25rem',
        calendarTitleHeight: '2.75rem',
        calendarTitleGridTempateColumns: '1.75rem 1.75rem 1fr 1.75rem 1.75rem',
        arrowSize: '1rem',
        calendarLeftPaddingDatetime: '0.25rem 0.75rem',
        panelHeaderPadding: '0.5rem 0.75rem',
        panelActionPadding: '0.5rem 0.75rem',
        scrollItemWidth: '5rem',
        scrollItemHeight: '2.5rem',
    },
    TimePicker: {
        itemFontSize: '1rem',
        itemHeight: '2.25rem',
        itemWidth: '3.25rem',
        panelActionPadding: '0.5rem 0',
    },
};
const props = defineProps<{
    id: string;
    label: string;
    kind: 'date' | 'time';
    disabled?: boolean;
    error?: string;
}>();
const model = defineModel<string>({ required: true });
const root = ref<HTMLElement>();
const timestamp = computed(() => {
    if (!model.value) return null;
    const value = new Date(model.value).getTime();
    return Number.isFinite(value) ? value : null;
});
function updateDate(value: number | [number, number] | null) {
    if (Array.isArray(value)) return;
    if (value === timestamp.value) return;
    if (value === null) {
        model.value = '';
        return;
    }
    const date = new Date(value);
    model.value = new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}
// Naive's picker exposes its native input through the rendered trigger, not an input-props API.
function labelInput() {
    const input = root.value?.querySelector('input');
    if (!input) return;
    input.id = props.id;
    input.setAttribute('aria-label', props.label);
    input.setAttribute('aria-invalid', props.error ? 'true' : 'false');
    if (props.error) input.setAttribute('aria-describedby', `${props.id}-error`);
    else input.removeAttribute('aria-describedby');
}
onMounted(labelInput);
onUpdated(labelInput);
</script>
