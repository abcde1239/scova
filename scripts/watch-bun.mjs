import { spawn } from 'node:child_process';
import { existsSync, readdirSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function watchBun(executable, args, options) {
    const packages = fileURLToPath(new URL('../packages/', import.meta.url));
    const roots = [resolve('src')];
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
        const source = join(packages, entry.name, 'src');
        if (entry.isDirectory() && existsSync(source)) roots.push(source);
    }

    const watchers = [];
    let child;
    let reload;
    let forceExit;
    let restarting = false;
    let stopping = false;

    function stopChild() {
        if (!child || forceExit) return;
        const processToStop = child;
        forceExit = setTimeout(() => processToStop.kill(), 10_000).unref();
        if (processToStop.connected) {
            processToStop.send('scova:shutdown', (error) => {
                if (error) processToStop.kill();
            });
        } else processToStop.kill();
    }

    function stop() {
        stopping = true;
        clearTimeout(reload);
        for (const watcher of watchers) watcher.close();
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        stopChild();
    }

    function launch() {
        restarting = false;
        process.exitCode = 0;
        child = spawn(executable, args, {
            ...options,
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });
        child.once('error', () => {
            console.error('无法启动本地 Bun，请检查 BUN_BIN。');
            process.exitCode = 1;
            stop();
        });
        child.once('close', (code) => {
            child = undefined;
            clearTimeout(forceExit);
            forceExit = undefined;
            if (stopping) return;
            if (restarting) launch();
            else process.exitCode = code ?? 1;
        });
    }

    function sourceChanged(_event, filename) {
        if (stopping || (filename && !/\.(?:[cm]?[jt]sx?|json)$/.test(filename))) return;
        clearTimeout(reload);
        reload = setTimeout(() => {
            if (!child) {
                launch();
                return;
            }
            restarting = true;
            stopChild();
        }, 150);
    }

    function watchFailed() {
        console.error('无法监听本地源码，请检查工作区目录。');
        process.exitCode = 1;
        stop();
    }

    try {
        for (const root of roots) {
            const watcher = watch(root, { recursive: true }, sourceChanged);
            watchers.push(watcher);
            watcher.on('error', watchFailed);
        }
    } catch {
        watchFailed();
        return;
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    launch();
}
