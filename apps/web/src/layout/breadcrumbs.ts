import type { InjectionKey, ShallowRef } from 'vue';

export type BreadcrumbContext = { path: string; label: string; to: string };
export const breadcrumbContext: InjectionKey<ShallowRef<BreadcrumbContext | undefined>> =
    Symbol('breadcrumbContext');
