import { themeVariables } from '@/theme/tokens';
import type { Accent, ColorScheme } from '@/theme/tokens';
import '@/theme/theme.css';
import '@/theme/glass.css';

const demo = document.querySelector<HTMLDivElement>('#demo')!;
const scheme = document.querySelector<HTMLSelectElement>('#scheme')!;
const accent = document.querySelector<HTMLSelectElement>('#accent')!;
const background = document.querySelector<HTMLSelectElement>('#background')!;
const solid = document.querySelector<HTMLInputElement>('#solid')!;
const stage = document.querySelector<HTMLElement>('#stage')!;
const backgrounds: Record<string, string> = { black: '#000000', white: '#ffffff', blue: '#0649b7' };

function update() {
    for (const [name, value] of Object.entries(
        themeVariables(accent.value as Accent, scheme.value as ColorScheme),
    )) {
        demo.style.setProperty(name, value);
    }
    demo.classList.toggle('scova-theme--dark', scheme.value === 'dark');
    stage.dataset.background = background.value;
    stage.style.setProperty('--demo-backdrop', backgrounds[background.value] ?? '#000000');
    demo.dataset.reducedTransparency = String(solid.checked);
}

for (const control of [scheme, accent, background, solid])
    control.addEventListener('change', update);
update();
