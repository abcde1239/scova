import type { GlobalThemeOverrides } from 'naive-ui';

export const accentOptions = [
    { value: 'blue', label: '蓝色' },
    { value: 'pine', label: '松绿' },
    { value: 'iris', label: '鸢尾' },
    { value: 'amber', label: '琥珀' },
] as const;
export const modeOptions = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色' },
] as const;
export type Accent = (typeof accentOptions)[number]['value'];
export type AppearanceMode = (typeof modeOptions)[number]['value'];
export type ColorScheme = 'light' | 'dark';

const accents = {
    blue: { light: ['#1d4ed8', '#1e40af', '#1e3a8a'], dark: ['#93c5fd', '#bfdbfe', '#60a5fa'] },
    pine: { light: ['#047857', '#065f46', '#064e3b'], dark: ['#6ee7b7', '#a7f3d0', '#34d399'] },
    iris: { light: ['#6d28d9', '#5b21b6', '#4c1d95'], dark: ['#c4b5fd', '#ddd6fe', '#a78bfa'] },
    amber: { light: ['#92400e', '#78350f', '#713f12'], dark: ['#fcd34d', '#fde68a', '#fbbf24'] },
} as const;

/** 状态色独立于品牌色；正文与内容表面保持中性。 */
export function themeTokens(accent: Accent, scheme: ColorScheme) {
    const [primary, primaryHover, primaryPressed] = accents[accent][scheme];
    const dark = scheme === 'dark';
    return {
        primary,
        primaryHover,
        primaryPressed,
        onPrimary: dark ? '#111827' : '#ffffff',
        canvas: dark ? '#101418' : '#f8fafc',
        surface: dark ? '#191f26' : '#ffffff',
        text: dark ? '#f1f5f9' : '#17212f',
        muted: dark ? '#b4c0cf' : '#526174',
        border: dark ? '#7b8ba1' : '#738297',
        selected: dark ? '#293340' : '#eef2f7',
        partial: dark ? '#fcd34d' : '#92400e',
        danger: dark ? '#fca5a5' : '#b91c1c',
        success: dark ? '#6ee7b7' : '#047857',
    };
}

export function themeOverrides(accent: Accent, scheme: ColorScheme): GlobalThemeOverrides {
    const colors = themeTokens(accent, scheme);
    return {
        common: {
            primaryColor: colors.primary,
            primaryColorHover: colors.primaryHover,
            primaryColorPressed: colors.primaryPressed,
            primaryColorSuppl: colors.primaryPressed,
            textColor1: colors.text,
            textColor2: colors.text,
            textColor3: colors.muted,
            bodyColor: colors.canvas,
            cardColor: colors.surface,
            modalColor: colors.surface,
            popoverColor: colors.surface,
            borderColor: colors.border,
            warningColor: colors.partial,
            errorColor: colors.danger,
            successColor: colors.success,
            fontFamily: 'var(--scova-font-interface)',
            fontSize: '1rem',
            fontSizeMini: '0.875rem',
            fontSizeTiny: '0.875rem',
            fontSizeSmall: '0.9375rem',
            fontSizeMedium: '1rem',
            fontSizeLarge: '1.125rem',
            fontSizeHuge: '1.25rem',
            heightMini: '2rem',
            heightTiny: '2.25rem',
            heightSmall: '2.5rem',
            heightMedium: '2.75rem',
            heightLarge: '3rem',
            heightHuge: '3.25rem',
            borderRadius: '0.375rem',
            borderRadiusSmall: '0.25rem',
            lineHeight: '1.6',
        },
        Button: {
            textColorPrimary: colors.onPrimary,
            textColorHoverPrimary: colors.onPrimary,
            textColorPressedPrimary: colors.onPrimary,
            textColorFocusPrimary: colors.onPrimary,
        },
        Input: {
            borderFocus: `0.0625rem solid ${colors.primary}`,
            boxShadowFocus: `0 0 0 0.125rem color-mix(in srgb, ${colors.primary} 10%, transparent)`,
            borderFocusError: `0.0625rem solid ${colors.danger}`,
            boxShadowFocusError: `0 0 0 0.125rem color-mix(in srgb, ${colors.danger} 10%, transparent)`,
        },
        Notification: {
            color: colors.surface,
            textColor: colors.text,
            headerTextColor: colors.text,
            descriptionTextColor: colors.muted,
            width: 'min(24rem, calc(100vw - 2rem))',
            padding: '1rem',
            fontSize: '0.9375rem',
            titleFontSize: '1rem',
            lineHeight: '1.6',
            borderRadius: '0.75rem',
            closeSize: '1.75rem',
            closeIconSize: '1.125rem',
            boxShadow: '0 0.5rem 2rem rgb(0 0 0 / 12%)',
        },
    };
}

export function themeVariables(accent: Accent, scheme: ColorScheme) {
    return Object.fromEntries(
        Object.entries(themeTokens(accent, scheme)).map(([name, value]) => [
            `--scova-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
            value,
        ]),
    );
}
