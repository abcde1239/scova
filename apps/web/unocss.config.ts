import { defineConfig, presetWind3, transformerDirectives, transformerVariantGroup } from 'unocss';

export default defineConfig({
    presets: [presetWind3()],
    transformers: [transformerDirectives(), transformerVariantGroup()],
    theme: {
        animation: {
            keyframes: {
                'action-spin': '{to{transform:rotate(360deg)}}',
                'select-reveal':
                    '{from{opacity:0;transform:translateY(-0.25rem)}to{opacity:1;transform:translateY(0)}}',
            },
            durations: { 'action-spin': '0.8s', 'select-reveal': '150ms' },
            timingFns: { 'action-spin': 'linear', 'select-reveal': 'ease-out' },
            counts: { 'action-spin': 'infinite', 'select-reveal': '1' },
        },
    },
    shortcuts: {
        'report-select':
            'font-inherit w-full min-w-0 max-w-full min-h-11 border-theme rounded-2 bg-surface text-default cursor-pointer p-2.5 keyboard-focus-wide disabled:cursor-not-allowed',
        'report-open-button':
            'font-inherit border-theme rounded-2 min-h-11 bg-surface text-primary px-3 cursor-pointer keyboard-focus-wide',
        'source-disclosure-control':
            'cursor-pointer rounded-2 keyboard-focus-inset motion-safe:transition-colors [&:hover:not(:active)]:([background:color-mix(in_srgb,_var(--scova-selected)_60%,_transparent)] text-primary) [&:focus-visible:not(:active)]:([background:color-mix(in_srgb,_var(--scova-selected)_60%,_transparent)] text-primary) active:([background:var(--scova-selected)] text-primary [box-shadow:inset_0_0_0_0.0625rem_color-mix(in_srgb,_var(--scova-primary)_35%,_transparent)])',
        'source-inline-action':
            'active:(text-primary underline underline-offset-[0.2em]) motion-safe:transition-colors',
        'report-directory-link': '[flex:1_1_0] min-w-0 max-w-full break-anywhere',
        'danger-action':
            '[&&]:text-danger [&.danger_.n-button\\_\\_content]:text-danger [&.danger_.n-button\\_\\_border]:[border-color:var(--scova-danger)] [&.danger_.n-button\\_\\_state-border]:[border-color:var(--scova-danger)]',
        'navigation-control':
            '[&&]:(min-h-11 h-auto max-w-full text-[1rem] no-underline py-2 px-3.5) [&.navigation-button_.n-button\\_\\_content]:(gap-[0.5em] whitespace-normal break-anywhere min-w-0)',
        'notification-control':
            'inline-flex items-center gap-[0.5em] min-h-11 [border:0] rounded-2 bg-transparent text-inherit font-inherit cursor-pointer py-2 px-3.5 keyboard-focus-wide hover:([background:var(--scova-selected)] text-primary) [&.selected]:([background:var(--scova-selected)] text-primary font-semibold underline underline-offset-[0.35em])',
        'page-container': 'mx-auto w-full max-w-5xl px-6 py-12',
        'theme-surface': 'bg-surface text-default',
        'theme-selected': '[background:var(--scova-selected)] text-primary',
        'internal-link':
            'no-underline rounded-1 [color:color-mix(in_srgb,_var(--scova-primary)_72%,_var(--scova-text))] hover:[color:var(--scova-primary)] active:(underline underline-offset-[0.2em]) keyboard-focus motion-safe:transition-colors',
        'external-link':
            'no-underline rounded-1 text-default hover:text-primary active:(underline underline-offset-[0.2em]) keyboard-focus motion-safe:transition-colors inline-flex items-center gap-1.5 w-fit max-w-full justify-self-start min-h-11 break-anywhere',
        'navigation-link':
            'internal-link inline-flex items-center gap-1.5 w-fit max-w-full justify-self-start min-h-11 break-anywhere font-medium',
        'title-link':
            'no-underline rounded-1 text-default hover:text-primary active:(underline underline-offset-[0.2em]) keyboard-focus motion-safe:transition-colors',
        'reference-link':
            'internal-link inline-flex items-center min-h-11 w-fit max-w-full justify-self-start gap-1.5',
        'theme-partial': '[color:var(--scova-partial)]',
        'theme-failure': 'text-danger',
        'text-muted': '[color:var(--scova-muted)]',
        'text-primary': '[color:var(--scova-primary)]',
        'text-danger': '[color:var(--scova-danger)]',
        'text-default': '[color:var(--scova-text)]',
        'bg-surface': '[background:var(--scova-surface)]',
        'break-anywhere': '[overflow-wrap:anywhere]',
        'border-theme': '[border:0.0625rem_solid_var(--scova-border)]',
        'border-subtle':
            '[border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)]',
        'border-control': '[border:0.0625rem_solid_var(--scova-select-border)]',
        'font-inherit':
            '[font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit] leading-[inherit] [font-variant:inherit]',
        'layout-stack': 'grid gap-4 min-w-0',
        'segmented-track':
            'inline-flex flex-wrap gap-1 max-w-full rounded-2.5 p-1 [background:color-mix(in_srgb,_var(--scova-border)_22%,_transparent)]',
        'segmented-item':
            'inline-flex items-center justify-center min-h-10 rounded-2 py-1.5 px-3.5 text-muted no-underline cursor-pointer whitespace-nowrap [transition:background-color_150ms,color_150ms,box-shadow_150ms] hover:text-default',
        'segmented-selected':
            'bg-surface text-default font-semibold [box-shadow:0_0.0625rem_0.1875rem_color-mix(in_srgb,_var(--scova-text)_14%,_transparent)]',
        'report-grid': 'grid gap-5 min-w-0 break-anywhere',
        'layout-grid': 'grid min-w-0',
        'action-row': 'flex flex-wrap items-center gap-3',
        'action-group': 'flex flex-wrap gap-3',
        'keyboard-focus':
            'focus-visible:[outline:0.125rem_solid_var(--scova-primary)] focus-visible:[outline-offset:0.1875rem]',
        'keyboard-focus-wide':
            'focus-visible:[outline:0.125rem_solid_var(--scova-primary)] focus-visible:[outline-offset:0.25rem]',
        'keyboard-focus-inset':
            'focus-visible:[outline:0.125rem_solid_var(--scova-primary)] focus-visible:[outline-offset:-0.125rem]',
        'scova-surface': '[background:var(--scova-surface)] [color:var(--scova-text)]',
        'scova-selected': '[background:var(--scova-selected)] [color:var(--scova-primary)]',
        'scova-partial': '[color:var(--scova-partial)]',
        'empty-copy':
            '[margin:0] [padding-block:1.5rem] [color:var(--scova-muted)] [font-size:0.9375rem]',
        'scova-pagination':
            '[display:flex] [justify-content:center] [inline-size:100%] [min-inline-size:0] [padding-block:1rem]',
        'scova-failure': '[color:var(--scova-danger)]',
        'scova-reading':
            '[font-family:var(--scova-reading-family,_var(--scova-font-reading))] [font-size:clamp(1rem,_var(--scova-reading-size,_1rem),_1.1875rem)] [font-weight:400] [line-height:2] [overflow-wrap:anywhere]',
        'scova-note':
            '[font-family:var(--scova-reading-family,_var(--scova-font-reading))] [font-size:clamp(1rem,_var(--scova-reading-size,_1rem),_1.1875rem)] [font-weight:400] [line-height:2] [overflow-wrap:anywhere]',
        'scova-interface':
            '[font-family:var(--scova-font-interface)] [font-size:1rem] [font-weight:400] [line-height:1.75]',
        'scova-ui':
            '[font-family:var(--scova-font-interface)] [font-size:1rem] [font-weight:400] [line-height:1.75]',
        'scova-action':
            '[font-family:var(--scova-font-interface)] [font-size:1rem] [font-weight:500]',
        'scova-heading':
            '[font-family:var(--scova-font-interface)] [font-size:1.5rem] [font-weight:600] [line-height:1.5] [overflow-wrap:anywhere]',
        'scova-content-title':
            '[font-family:var(--scova-font-reading)] font-semibold leading-[1.6] break-anywhere [font-size:clamp(1.25rem,_1.125rem_+_0.5vw,_1.5rem)]',
        'scova-report-title':
            '[font-family:var(--scova-font-reading)] font-semibold leading-[1.6] break-anywhere [font-size:clamp(1.75rem,_1.5rem_+_1vw,_2.25rem)]',
        'scova-caption': '[font-size:0.875rem] [line-height:1.6]',
    },
});
