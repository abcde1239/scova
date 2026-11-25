<template>
    <div
        class="app-select"
        :class="{
            'app-select--invalid': invalid,
            'app-select--compact': compact,
            'app-select--icon': iconOnly,
        }"
    >
        <button
            :id="id"
            ref="trigger"
            type="button"
            class="select-trigger"
            :role="searchable ? undefined : 'combobox'"
            :aria-haspopup="searchable ? 'dialog' : 'listbox'"
            :aria-label="label"
            :title="iconOnly ? `${label}: ${selected?.label ?? placeholder}` : undefined"
            :aria-expanded="open"
            :aria-controls="open ? (searchable ? `${id}-panel` : `${id}-options`) : undefined"
            :aria-activedescendant="open && !searchable ? activeId : undefined"
            :aria-invalid="invalid || undefined"
            :aria-describedby="describedby"
            :disabled="disabled"
            @click="open ? close() : show()"
            @keydown="onKeydown"
            @focusout="onFocusout"
        >
            <span v-if="selected?.color || selected?.icon || icon" class="select-leading">
                <template v-if="iconOnly && icon && selected?.color">
                    <app-icon :name="icon" />
                    <span class="select-badge" :style="{ background: selected.color }" />
                </template>
                <span
                    v-else-if="selected?.color"
                    class="select-swatch"
                    :style="{ background: selected.color }"
                />
                <app-icon v-else-if="selected?.icon || icon" :name="selected?.icon || icon!" />
            </span>
            <span class="select-value">
                <span>{{ selected?.label ?? placeholder }}</span>
                <small v-if="!compact && selected?.description">{{ selected.description }}</small>
            </span>
            <app-icon class="select-chevron" name="expand" />
        </button>
        <teleport to=".scova-theme">
            <div
                v-if="open"
                :id="`${id}-panel`"
                ref="panel"
                class="select-panel"
                :class="{ 'select-panel--short': shortViewport }"
                :role="searchable ? 'dialog' : undefined"
                :aria-label="searchable ? `选择${label}` : undefined"
                :style="placement"
                @keydown="onKeydown"
                @focusout="onFocusout"
            >
                <div class="select-heading">
                    <span>{{ label }}</span>
                    <span v-if="searchable" class="select-count">{{ filtered.length }} 个选项</span>
                </div>
                <div v-if="searchable" class="select-search">
                    <app-icon name="search" />
                    <input
                        ref="search"
                        v-model="query"
                        type="text"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded="true"
                        :aria-label="`搜索${label}`"
                        :aria-controls="`${id}-options`"
                        :aria-activedescendant="activeId"
                        :placeholder="searchPlaceholder"
                        autocomplete="off"
                        :spellcheck="false"
                    />
                </div>
                <ul
                    :id="`${id}-options`"
                    ref="optionList"
                    role="listbox"
                    :aria-label="label"
                    class="select-options"
                >
                    <li
                        v-for="(option, index) in filtered"
                        :id="`${id}-option-${index}`"
                        :key="option.value"
                        role="option"
                        :aria-selected="option.value === modelValue"
                        class="select-option"
                        :class="{ 'is-active': index === active }"
                        @pointermove="active = index"
                        @mousedown.prevent
                        @click="choose(option.value)"
                    >
                        <span v-if="option.color || option.icon" class="select-option-icon">
                            <span
                                v-if="option.color"
                                class="select-swatch"
                                :style="{ background: option.color }"
                            />
                            <app-icon v-else-if="option.icon" :name="option.icon" />
                        </span>
                        <span class="select-option-copy">
                            <span>{{ option.label }}</span>
                            <small v-if="option.description">{{ option.description }}</small>
                        </span>
                        <span v-if="option.value === modelValue" class="select-check"
                            ><app-icon name="confirm"
                        /></span>
                    </li>
                </ul>
                <p v-if="!filtered.length" class="select-empty" role="status">
                    没有找到匹配项，请换个关键词
                </p>
            </div>
        </teleport>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import type { CSSProperties } from 'vue';
import AppIcon from '@/component/common/AppIcon.vue';
import type { IconName } from '@/utils/icons';

type Option = {
    value: string;
    label: string;
    description?: string;
    color?: string;
    icon?: IconName;
};
const props = withDefaults(
    defineProps<{
        id?: string;
        label: string;
        options: readonly Option[];
        searchable?: boolean;
        compact?: boolean;
        iconOnly?: boolean;
        searchPlaceholder?: string;
        disabled?: boolean;
        invalid?: boolean;
        describedby?: string;
        placeholder?: string;
        icon?: IconName;
    }>(),
    { placeholder: '请选择', searchPlaceholder: '搜索选项' },
);
const modelValue = defineModel<string>({ required: true });
const autoId = useId();
const id = computed(() => props.id ?? `${autoId}-select`);
const selected = computed(() => props.options.find((option) => option.value === modelValue.value));
const open = ref(false);
const query = ref('');
const active = ref(0);
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLDivElement>();
const search = ref<HTMLInputElement>();
const optionList = ref<HTMLUListElement>();
const placement = ref<CSSProperties>({});
const shortViewport = ref(false);
const filtered = computed(() => {
    const keyword = query.value.trim().toLocaleLowerCase();
    return props.options.filter((option) =>
        `${option.label} ${option.description ?? ''} ${option.value}`
            .toLocaleLowerCase()
            .includes(keyword),
    );
});
const activeId = computed(() =>
    filtered.value[active.value] ? `${id.value}-option-${active.value}` : undefined,
);
watch(query, () => {
    active.value = 0;
});
watch(
    () => props.disabled,
    (disabled) => {
        if (disabled) close();
    },
);
watch(filtered, (options) => {
    active.value = Math.max(0, Math.min(active.value, options.length - 1));
    scrollActive();
});

async function show() {
    if (props.disabled || !trigger.value) return;
    query.value = '';
    active.value = Math.max(
        0,
        props.options.findIndex((option) => option.value === modelValue.value),
    );
    if (!positionPanel()) return;
    open.value = true;
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', positionPanel);
    window.visualViewport?.addEventListener('scroll', positionPanel);
    await nextTick();
    if (props.searchable) search.value?.focus({ preventScroll: true });
    scrollActive();
}
function positionPanel() {
    if (!trigger.value) return false;
    const rect = trigger.value.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight) {
        close();
        return false;
    }
    const unit = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const gap = unit * 0.5;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + gap;
    const top = (viewport?.offsetTop ?? 0) + gap;
    const right = left + (viewport?.width ?? innerWidth) - 2 * gap;
    const bottom = top + (viewport?.height ?? innerHeight) - 2 * gap;
    const width = Math.min(
        Math.max(rect.width, props.searchable ? 20 * unit : 14 * unit),
        Math.max(0, right - left),
    );
    const below = Math.max(0, bottom - Math.max(top, rect.bottom + gap));
    const above = Math.max(0, Math.min(bottom, rect.top - gap) - top);
    const down = below >= Math.min(16 * unit, above);
    const useViewport = Math.max(below, above) < (props.searchable ? 12 : 6) * unit;
    const maxHeight = Math.max(
        0,
        useViewport ? bottom - top : Math.min(23 * unit, down ? below : above),
    );
    shortViewport.value = maxHeight < 12 * unit;
    // DOM 几何使用 px；软键盘与缩放后的可见区偏移仍在布局视口坐标系中。
    placement.value = {
        width: `${width}px`,
        left: `${Math.max(left, Math.min(rect.left, right - width))}px`,
        maxHeight: `${maxHeight}px`,
        ...(useViewport
            ? { top: `${top}px` }
            : down
              ? { top: `${Math.max(top, rect.bottom + gap)}px` }
              : { bottom: `${innerHeight - Math.min(bottom, rect.top - gap)}px` }),
    };
    scrollActive();
    return true;
}
function close(restoreFocus = false) {
    open.value = false;
    document.removeEventListener('pointerdown', outside);
    window.removeEventListener('resize', positionPanel);
    window.removeEventListener('scroll', onScroll, true);
    window.visualViewport?.removeEventListener('resize', positionPanel);
    window.visualViewport?.removeEventListener('scroll', positionPanel);
    if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function onFocusout(event: FocusEvent) {
    const target = event.relatedTarget;
    if (
        !(target instanceof Node) ||
        (!panel.value?.contains(target) && !trigger.value?.contains(target))
    )
        close();
}
function outside(event: PointerEvent) {
    const node = event.target as Node;
    if (!trigger.value?.contains(node) && !panel.value?.contains(node)) close();
}
function onScroll(event: Event) {
    if (!(event.target instanceof Node) || !panel.value?.contains(event.target)) positionPanel();
}
function choose(value: string) {
    if (props.disabled) return;
    modelValue.value = value;
    close(true);
}
function scrollActive() {
    void nextTick(() => {
        const list = optionList.value;
        const option = activeId.value ? document.getElementById(activeId.value) : null;
        if (!list || !option) return;
        // 仅滚动选项列表，不能让长表单跟着浮层的焦点移动。
        const bounds = list.getBoundingClientRect();
        const item = option.getBoundingClientRect();
        if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
        else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
    });
}
function onKeydown(event: KeyboardEvent) {
    if (event.isComposing || props.disabled) return;
    if (event.key === 'Escape' && open.value) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
    } else if (event.key === 'Tab' && open.value) {
        close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!open.value) {
            void show();
            return;
        }
        active.value = Math.max(
            0,
            Math.min(
                filtered.value.length - 1,
                active.value + (event.key === 'ArrowDown' ? 1 : -1),
            ),
        );
        scrollActive();
    } else if (
        (event.key === 'Home' || event.key === 'End') &&
        open.value &&
        event.target === trigger.value
    ) {
        event.preventDefault();
        active.value = event.key === 'Home' ? 0 : filtered.value.length - 1;
        scrollActive();
    } else if (event.key === 'Enter' && open.value) {
        event.preventDefault();
        event.stopPropagation();
        const option = filtered.value[active.value];
        if (option) choose(option.value);
    } else if (event.key === ' ' && open.value && event.target === trigger.value) {
        event.preventDefault();
        const option = filtered.value[active.value];
        if (option) choose(option.value);
    } else if (
        !props.searchable &&
        event.key.length === 1 &&
        event.key !== ' ' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
    ) {
        const match = props.options.findIndex((option) =>
            option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()),
        );
        if (match >= 0) {
            event.preventDefault();
            if (!open.value)
                void show().then(() => {
                    active.value = match;
                    scrollActive();
                });
            else {
                active.value = match;
                scrollActive();
            }
        }
    }
}
onBeforeUnmount(() => close());
defineExpose({ focus: () => trigger.value?.focus() });
</script>

<style scoped>
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.app-select {
    @apply min-w-0;
}
.select-trigger {
    @apply flex items-center gap-2.5 w-full min-h-11 pt-2.5 pr-3.5 pb-2.5 pl-3.5
        [border:0.0625rem_solid_var(--scova-select-border)] rounded-[var(--scova-select-radius)]
        bg-surface text-default [font-family:inherit] [font-size:inherit] [font-weight:inherit]
        [font-style:inherit] leading-[1.5] [font-variant:inherit] text-start cursor-pointer
        [transition:border-color_150ms,_box-shadow_150ms,_background-color_150ms];
}
.select-value {
    @apply layout-grid flex-1 gap-0.5 break-anywhere;
}
.select-value small {
    @apply text-[0.75rem] text-muted;
}
.select-leading {
    @apply grid place-items-center flex-none w-6 h-6 text-primary;
}
.app-select--compact .select-leading {
    @apply w-5 h-5 bg-transparent;
}
.app-select--compact .select-trigger {
    @apply pt-2 pr-3 pb-2 pl-3 min-h-11 rounded-[var(--scova-select-radius)];
}
.select-chevron {
    @apply ml-auto text-muted [transition:transform_150ms];
}
.app-select--icon .select-trigger {
    @apply justify-center w-9 h-9 min-h-9 p-0 gap-0 rounded-2 border-transparent bg-transparent text-muted;
}
.app-select--icon .select-leading {
    @apply relative w-5 h-5 text-muted;
}
.select-badge {
    @apply absolute right-[-0.1875rem] bottom-[-0.125rem] w-2.5 h-2.5 rounded-full
        [box-shadow:0_0_0_0.125rem_var(--scova-surface)];
}
.app-select--icon .select-value {
    @apply hidden;
}
.app-select--icon .select-chevron {
    @apply hidden;
}
.app-select--icon .select-trigger:hover:not(:disabled),
.app-select--icon .select-trigger[aria-expanded='true'] {
    @apply border-transparent [background:var(--scova-selected)] text-default;
}
@media (pointer: coarse) {
    .app-select--icon .select-trigger {
        @apply w-11 h-11 min-h-11;
    }
}
[aria-expanded='true'] .select-chevron {
    @apply [transform:rotate(180deg)];
}
.select-trigger:hover:not(:disabled) {
    @apply [border-color:var(--scova-select-hover-border)];
}
.select-trigger:focus-visible,
.select-trigger[aria-expanded='true'] {
    @apply [outline:none] [border-color:var(--scova-primary)]
        [box-shadow:0_0_0_0.1875rem_var(--scova-select-focus-ring)];
}
.select-trigger:disabled {
    @apply opacity-55 cursor-not-allowed;
}
.app-select--invalid .select-trigger:not(:disabled) {
    @apply [border-color:var(--scova-danger)];
}
.app-select--invalid .select-trigger:focus-visible,
.app-select--invalid .select-trigger[aria-expanded='true'] {
    @apply [box-shadow:0_0_0_0.1875rem_color-mix(in_srgb,_var(--scova-danger)_12%,_transparent)];
}
.select-panel {
    @apply fixed z-[2000] flex flex-col overflow-auto [overscroll-behavior:contain]
        [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_28%,_transparent)] rounded-2.5
        bg-surface text-default
        [box-shadow:0_0.75rem_2rem_-0.5rem_color-mix(in_srgb,_var(--scova-text)_14%,_transparent),_0_0.125rem_0.5rem_color-mix(in_srgb,_var(--scova-text)_4%,_transparent)]
        [font-family:var(--scova-font-interface)] text-[1rem] leading-[1.5] font-normal
        [font-style:normal] animate-select-reveal p-2;
}
.select-heading {
    @apply flex justify-between gap-2 flex-none pt-1.5 pr-2.5 pb-2.5 pl-2.5 text-muted text-[0.75rem]
        [font-weight:550];
}
.select-count {
    @apply font-normal;
}
.select-panel--short .select-heading {
    @apply hidden;
}
.select-options {
    @apply list-none min-h-11 overflow-auto [overscroll-behavior:contain] [scrollbar-width:thin]
        [scrollbar-color:color-mix(in_srgb,_var(--scova-border)_40%,_transparent)_transparent] m-0
        p-0;
}
.select-option {
    @apply flex items-center gap-2 min-h-11 pt-2.5 pr-3 pb-2.5 pl-3 rounded-1.5 cursor-pointer
        [border:0.0625rem_solid_transparent];
}
.select-option + .select-option {
    @apply mt-0.5;
}
.select-option.is-active {
    @apply [background:var(--scova-selected)];
}
.select-option[aria-selected='true'] {
    @apply font-medium text-primary
        [background:color-mix(in_srgb,_var(--scova-primary)_8%,_var(--scova-surface))];
}
.select-option.is-active[aria-selected='true'] {
    @apply [background:color-mix(in_srgb,_var(--scova-primary)_13%,_var(--scova-surface))];
}
.select-option-icon {
    @apply grid place-items-center w-7 h-7 flex-none rounded-2 bg-surface;
}
.select-option-copy {
    @apply layout-grid break-anywhere;
}
.select-option-copy small {
    @apply text-muted text-[0.8125rem];
}
.select-check {
    @apply grid place-items-center w-5 h-5 flex-none ml-auto text-primary text-[1rem];
}
.select-swatch {
    @apply w-3.5 h-3.5 flex-none rounded-[50%]
        [box-shadow:0_0_0_0.1875rem_color-mix(in_srgb,_var(--scova-surface)_75%,_transparent),_0_0_0_0.25rem_color-mix(in_srgb,_var(--scova-border)_22%,_transparent)];
}
.select-search {
    @apply flex items-center flex-none gap-2 pt-2.5 pr-3 pb-2.5 pl-3 mb-2
        [border:0.0625rem_solid_var(--scova-select-border)] rounded-[var(--scova-select-radius)]
        text-muted bg-surface;
}
.select-search:focus-within {
    @apply [border-color:var(--scova-primary)];
}
.select-search input {
    @apply font-inherit w-full min-w-0 [border:0] [outline:none] bg-transparent text-default;
}
.select-empty {
    @apply pt-5 pr-3 pb-5 pl-3 text-muted text-[0.875rem] text-center m-0;
}
@media (max-width: 30rem) {
    .app-select:not(.app-select--compact) .select-leading {
        @apply hidden;
    }
    .select-trigger {
        @apply gap-1.5 p-2.5;
    }
    .select-chevron {
        @apply text-[1rem];
    }
}
@media (prefers-reduced-motion: reduce) {
    .select-trigger,
    .select-chevron {
        @apply [transition:none];
    }
    .select-panel {
        @apply [animation:none];
    }
}
</style>
