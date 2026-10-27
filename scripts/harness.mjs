import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 固定项目根和工具快照，避免依赖开发者机器上的技能安装路径。
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('./vendor/harness-kit.mjs', import.meta.url));
const expectedHash = 'cc523948f6244abe42aa0f7d6be4a5bf14c39c9547bd88e2b2a7322ef594e5e2';
const command = process.argv[2];

function run() {
    if (!['lint', 'verify'].includes(command) || process.argv.length !== 3) {
        throw new Error('用法：vp run harness-lint 或 vp run harness-verify');
    }
    const hash = createHash('sha256').update(readFileSync(cli)).digest('hex');
    if (hash !== expectedHash) {
        throw new Error('Harness Kit 快照摘要不匹配，请审阅工具更新并同步摘要。');
    }

    // 优先使用独立 Bun；Vite+ 的 bun shim 可能尝试联网解析另一包管理器。
    const installed = join(
        homedir(),
        '.bun',
        'bin',
        process.platform === 'win32' ? 'bun.exe' : 'bun',
    );
    const candidates = process.env.BUN_BIN
        ? [process.env.BUN_BIN]
        : [...(existsSync(installed) ? [installed] : []), 'bun'];
    const bun = candidates.find((candidate) => {
        const probe = spawnSync(candidate, ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10000,
        });
        if (probe.status !== 0) return false;
        const match = /^(\d+)\.(\d+)\.(\d+)\s*$/.exec(probe.stdout.trim());
        if (!match) return false;
        const [, major, minor, patch] = match.map(Number);
        return major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 4)));
    });
    if (!bun) {
        throw new Error('需要 Bun >= 1.3.4；安装独立 Bun 或通过 BUN_BIN 指定可执行文件绝对路径。');
    }
    const env = { ...process.env };
    if (process.platform === 'win32') {
        // pnpm 的 .bin 同时包含无扩展名的 POSIX shim；Bun 无法把它作为 Windows 程序启动。
        const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
        const inheritedPath = env[pathKey] ?? '';
        const nativeVpDirectory = inheritedPath
            .split(delimiter)
            .find((directory) => existsSync(join(directory, 'vp.exe')));
        if (!nativeVpDirectory) throw new Error('PATH 中缺少原生 vp.exe，请安装全局 Vite+。');
        env[pathKey] = `${nativeVpDirectory}${delimiter}${inheritedPath}`;
    }
    const result = spawnSync(bun, [cli, command, '--root', root, '--json'], {
        cwd: root,
        env,
        stdio: 'inherit',
        windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status ?? 2;
}

try {
    process.exitCode = run();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
}
