<template>
    <main
        id="main-content"
        class="status-layout grid place-items-center min-h-[100dvh] box-border [background:var(--scova-canvas)] text-default p-[clamp(1.25rem,_5vw,_3rem)] focus:[outline:none]"
        tabindex="-1"
    >
        <div class="status-content w-full max-w-[30rem] break-anywhere"><slot /></div>
    </main>
</template>
