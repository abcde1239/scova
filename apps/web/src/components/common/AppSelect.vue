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
.app-select {
    min-inline-size: 0;
}
.select-trigger {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    inline-size: 100%;
    min-block-size: 2.75rem;
    padding: 0.625rem 0.875rem;
    border: 0.0625rem solid var(--scova-select-border);
    border-radius: var(--scova-select-radius);
    background: var(--scova-surface);
    color: var(--scova-text);
    font: inherit;
    line-height: 1.5;
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
    gap: 0.125rem;
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
    inline-size: 1.5rem;
    block-size: 1.5rem;
    color: var(--scova-primary);
}
.app-select--compact .select-leading {
    inline-size: 1.25rem;
    block-size: 1.25rem;
    background: transparent;
}
.app-select--compact .select-trigger {
    padding: 0.5rem 0.75rem;
    min-block-size: 2.75rem;
    border-radius: var(--scova-select-radius);
}
.select-chevron {
    margin-inline-start: auto;
    color: var(--scova-muted);
    transition: transform 150ms;
}
[aria-expanded='true'] .select-chevron {
    transform: rotate(180deg);
}
.select-trigger:hover:not(:disabled) {
    border-color: var(--scova-select-hover-border);
}
.select-trigger:focus-visible,
.select-trigger[aria-expanded='true'] {
    outline: none;
    border-color: var(--scova-primary);
    box-shadow: 0 0 0 0.1875rem var(--scova-select-focus-ring);
}
.select-trigger:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}
.app-select--invalid .select-trigger:not(:disabled) {
    border-color: var(--scova-danger);
}
.app-select--invalid .select-trigger:focus-visible,
.app-select--invalid .select-trigger[aria-expanded='true'] {
    box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--scova-danger) 12%, transparent);
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
    border-radius: 0.625rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    box-shadow:
        0 0.75rem 2rem -0.5rem color-mix(in srgb, var(--scova-text) 14%, transparent),
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
.select-panel--short .select-heading {
    display: none;
}
.select-options {
    padding: 0;
    margin: 0;
    list-style: none;
    min-block-size: 2.75rem;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--scova-border) 40%, transparent) transparent;
}
.select-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.375rem;
    cursor: pointer;
    border: 0.0625rem solid transparent;
}
.select-option + .select-option {
    margin-block-start: 0.125rem;
}
.select-option.is-active {
    background: var(--scova-selected);
}
.select-option[aria-selected='true'] {
    font-weight: 500;
    color: var(--scova-primary);
    background: color-mix(in srgb, var(--scova-primary) 8%, var(--scova-surface));
}
.select-option.is-active[aria-selected='true'] {
    background: color-mix(in srgb, var(--scova-primary) 13%, var(--scova-surface));
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
    color: var(--scova-primary);
    font-size: 1rem;
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
    border: 0.0625rem solid var(--scova-select-border);
    border-radius: var(--scova-select-radius);
    color: var(--scova-muted);
    background: var(--scova-surface);
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
</style>
