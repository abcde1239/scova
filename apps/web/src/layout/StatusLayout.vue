<template>
    <main id="main-content" class="status-layout" tabindex="-1">
        <div class="status-content"><slot /></div>
    </main>
</template>

<style scoped>
.status-layout {
    display: grid;
    place-items: center;
    min-block-size: 100dvh;
    box-sizing: border-box;
    padding: clamp(1.25rem, 5vw, 3rem);
    background: var(--scova-canvas);
    color: var(--scova-text);
}
.status-content {
    inline-size: 100%;
    max-inline-size: 30rem;
    overflow-wrap: anywhere;
}
.status-layout:focus {
    outline: none;
}
</style>
