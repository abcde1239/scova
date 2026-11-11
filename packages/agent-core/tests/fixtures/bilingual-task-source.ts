// Short official documentation excerpts; padding is synthetic and not source evidence.
// https://vuejs.org/guide/essentials/watchers.html
export const watcherSourceParagraphs = [
    'Note that onWatcherCleanup is only supported in Vue 3.5+ and must be called during the synchronous execution of a watchEffect effect function or watch callback function: you cannot call it after an await statement in an async function.',
    'Watchers declared synchronously inside setup() or <script setup> are bound to the owner component instance, and will be automatically stopped when the owner component is unmounted. In most cases, you do not need to worry about stopping the watcher yourself.',
    "The key here is that the watcher must be created synchronously: if the watcher is created in an async callback, it won't be bound to the owner component and must be stopped manually to avoid memory leaks. Here's an example:",
    'To manually stop a watcher, use the returned handle function. This works for both watch and watchEffect:',
];

export const watcherTaskFixture = {
    zh: {
        topic: 'Vue watchers onWatcherCleanup 与异步创建停止',
        goal: '根据 Vue 官方 watchers 文档，简明解释 onWatcherCleanup 的 Vue 3.5+ 版本要求、同步执行及 await 之前注册的限制，并解释异步回调创建的 watcher 是否自动停止，以及如何手动停止。保留适用条件与准确原文依据。',
        fields: [
            'Vue 3.5+ 版本要求',
            '同步执行要求',
            'await 之前注册的限制',
            '是否随组件卸载自动停止',
            '手动停止方式',
        ],
        objects: [
            'onWatcherCleanup',
            'onWatcherCleanup',
            'onWatcherCleanup',
            '在异步回调中创建的 watcher',
            '在异步回调中创建的 watcher',
        ],
    },
    en: {
        topic: 'Vue watcher cleanup and stopping asynchronously created watchers',
        goal: 'Explain onWatcherCleanup version 3.5+, synchronous execution and registration before await; explain automatic stopping of watchers created in asynchronous callbacks and the manual stopping method.',
        fields: [
            'version 3.5+',
            'synchronous execution',
            'registration before await',
            'automatic stop on component unmount',
            'manual stop method',
        ],
        objects: [
            'onWatcherCleanup',
            'onWatcherCleanup',
            'onWatcherCleanup',
            'watcher created in asynchronous callback',
            'watcher created in asynchronous callback',
        ],
    },
};

const padding = 'Historical background describes unrelated rendering and formatting examples.\n\n';
const distractors = [
    'A watcher callback can collect multiple data values before later updates.',
    'The component example has several callbacks for network events.',
    'A watcher demonstrates fetching a new item when a name changes.',
    'The callbacks are batched before the DOM update operation.',
    'A watcher callback can derive another value from current inputs.',
    'This component has an example for immediate data fetching.',
    'A watcher can be compared with declarative computed values.',
];
export const bilingualWatcherBody =
    '# Watchers\n\n' +
    distractors.map((text) => `${text}\n\n${padding.repeat(20)}`).join('') +
    watcherSourceParagraphs[0] +
    '\n\n' +
    padding.repeat(40) +
    watcherSourceParagraphs[1] +
    '\n\n' +
    watcherSourceParagraphs[2] +
    '\n\n' +
    'js\n\nsetTimeout(() => registerListener(), 100)\n\n' +
    watcherSourceParagraphs[3] +
    '\n\nconst stop = registerListener()\nstop()\n\n' +
    padding.repeat(40);
