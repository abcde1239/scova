<template>
    <div
        class="app-select"
        :class="{ 'app-select--invalid': invalid, 'app-select--compact': compact }"
    >
        <button
            :id="id"
            ref="trigger"
            type="button"
            class="select-trigger"
            :role="searchable ? undefined : 'combobox'"
            :aria-haspopup="searchable ? 'dialog' : 'listbox'"
            :aria-label="label"
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
                <span
                    v-if="selected?.color"
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
import AppIcon from '@/components/common/AppIcon.vue';
import type { IconName } from '@/components/common/icons';

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
    const width = Math.min(
        Math.max(rect.width, props.searchable ? 20 * unit : 14 * unit),
        innerWidth - 2 * gap,
    );
    const below = innerHeight - rect.bottom - 2 * gap;
    const above = rect.top - 2 * gap;
    const down = below >= Math.min(16 * unit, above);
    const useViewport = Math.max(below, above) < (props.searchable ? 12 : 6) * unit;
    // 固定浮层使用实际视口坐标，避免窄屏/放大时被父级布局裁切。
    placement.value = {
        width: `${width}px`,
        left: `${Math.max(gap, Math.min(rect.left, innerWidth - width - gap))}px`,
        maxHeight: `${useViewport ? innerHeight - 2 * gap : Math.max(unit * 3, Math.min(23 * unit, down ? below : above))}px`,
        ...(useViewport
            ? { top: `${gap}px` }
            : down
              ? { top: `${rect.bottom + gap}px` }
              : { bottom: `${innerHeight - rect.top + gap}px` }),
    };
    return true;
}
function close(restoreFocus = false) {
    open.value = false;
    document.removeEventListener('pointerdown', outside);
    window.removeEventListener('resize', positionPanel);
    window.removeEventListener('scroll', onScroll, true);
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
.app-select {
    min-inline-size: 0;
}
.select-trigger {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    inline-size: 100%;
    min-block-size: 2.875rem;
    padding: 0.625rem 0.875rem;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 32%, transparent);
    border-radius: 0.875rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition:
        border-color 150ms,
        box-shadow 150ms,
        background-color 150ms;
}
.select-value {
    display: grid;
    flex: 1;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.select-value small {
    font-size: 0.75rem;
    color: var(--scova-muted);
}
.select-leading {
    display: grid;
    place-items: center;
    flex: none;
    inline-size: 2rem;
    block-size: 2rem;
    border-radius: 0.625rem;
    color: var(--scova-primary);
    background: var(--scova-selected);
}
.app-select--compact .select-leading {
    inline-size: 1.25rem;
    block-size: 1.25rem;
    background: transparent;
}
.app-select--compact .select-trigger {
    padding: 0.5rem 0.75rem;
    min-block-size: 2.75rem;
    border-radius: 0.75rem;
}
.select-chevron {
    margin-inline-start: auto;
    color: var(--scova-muted);
    transition: transform 150ms;
}
[aria-expanded='true'] .select-chevron {
    transform: rotate(180deg);
}
.select-trigger:hover {
    border-color: var(--scova-primary);
}
.select-trigger:focus-visible,
.select-trigger[aria-expanded='true'] {
    outline: none;
    border-color: var(--scova-primary);
    box-shadow: 0 0 0 0.125rem color-mix(in srgb, var(--scova-primary) 10%, transparent);
}
.select-trigger:disabled {
    opacity: 0.55;
    cursor: default;
}
.app-select--invalid .select-trigger {
    border-color: var(--scova-danger);
}
.select-panel {
    position: fixed;
    z-index: 2000;
    display: flex;
    flex-direction: column;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 0.5rem;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 28%, transparent);
    border-radius: 1rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    box-shadow:
        0 1rem 3rem -0.75rem color-mix(in srgb, var(--scova-text) 20%, transparent),
        0 0.125rem 0.5rem color-mix(in srgb, var(--scova-text) 4%, transparent);
    font: 1rem/1.5 var(--scova-font-interface);
    animation: select-reveal 150ms ease-out;
}
.select-heading {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    flex: none;
    padding: 0.375rem 0.625rem 0.625rem;
    color: var(--scova-muted);
    font-size: 0.75rem;
    font-weight: 550;
}
.select-count {
    font-weight: 400;
}
.select-options {
    padding: 0;
    margin: 0;
    list-style: none;
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--scova-border) 40%, transparent) transparent;
}
.select-option {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-block-size: 2.875rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.625rem;
    cursor: pointer;
    border: 0.0625rem solid transparent;
}
.select-option + .select-option {
    margin-block-start: 0.125rem;
}
.select-option.is-active {
    background: var(--scova-selected);
    border-color: color-mix(in srgb, var(--scova-primary) 25%, transparent);
}
.select-option[aria-selected='true'] {
    color: var(--scova-primary);
    background: color-mix(in srgb, var(--scova-primary) 8%, var(--scova-surface));
}
.select-option-icon {
    display: grid;
    place-items: center;
    inline-size: 1.75rem;
    block-size: 1.75rem;
    flex: none;
    border-radius: 0.5rem;
    background: var(--scova-surface);
}
.select-option-copy {
    display: grid;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.select-option-copy small {
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.select-check {
    display: grid;
    place-items: center;
    inline-size: 1.25rem;
    block-size: 1.25rem;
    flex: none;
    margin-inline-start: auto;
    border-radius: 50%;
    background: var(--scova-primary);
    color: var(--scova-on-primary);
    font-size: 0.875rem;
}
.select-swatch {
    inline-size: 0.875rem;
    block-size: 0.875rem;
    flex: none;
    border-radius: 50%;
    box-shadow:
        0 0 0 0.1875rem color-mix(in srgb, var(--scova-surface) 75%, transparent),
        0 0 0 0.25rem color-mix(in srgb, var(--scova-border) 22%, transparent);
}
.select-search {
    display: flex;
    align-items: center;
    flex: none;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    margin-block-end: 0.5rem;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 40%, transparent);
    border-radius: 0.625rem;
    color: var(--scova-muted);
    background: var(--scova-canvas);
}
.select-search:focus-within {
    border-color: var(--scova-primary);
}
.select-search input {
    inline-size: 100%;
    min-inline-size: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--scova-text);
    font: inherit;
}
.select-empty {
    padding: 1.25rem 0.75rem;
    margin: 0;
    color: var(--scova-muted);
    font-size: 0.875rem;
    text-align: center;
}
@media (max-width: 30rem) {
    .app-select:not(.app-select--compact) .select-leading {
        display: none;
    }
    .select-trigger {
        gap: 0.375rem;
        padding: 0.625rem;
    }
    .select-chevron {
        font-size: 1rem;
    }
}
@supports (backdrop-filter: blur(1rem)) {
    .select-panel {
        background: color-mix(in srgb, var(--scova-surface) 96%, transparent);
        backdrop-filter: blur(1rem);
    }
}
:global([data-reduced-transparency='true'] .select-panel) {
    background: var(--scova-surface);
    backdrop-filter: none;
}
@keyframes select-reveal {
    from {
        opacity: 0;
        transform: translateY(-0.25rem);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}
@media (prefers-reduced-motion: reduce) {
    .select-trigger,
    .select-chevron {
        transition: none;
    }
    .select-panel {
        animation: none;
    }
}
@media (prefers-reduced-transparency: reduce) {
    .select-panel {
        background: var(--scova-surface);
        backdrop-filter: none;
    }
}
</style>
