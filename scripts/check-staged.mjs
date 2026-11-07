import { execFileSync, spawnSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
const stagedPaths = () =>
    git('diff', '--cached', '--name-only', '--no-renames', '-z').split('\0').filter(Boolean);

try {
    const selected = stagedPaths();
    if (selected.length) {
        const entries = new Map(
            git('ls-files', '--stage', '-z', '--', ...selected)
                .split('\0')
                .filter(Boolean)
                .map((entry) => {
                    const separator = entry.indexOf('\t');
                    return [entry.slice(separator + 1), entry.slice(0, separator).split(' ')];
                }),
        );
        const originalPaths = new Set(
            git('ls-tree', '-rz', '--name-only', 'HEAD', '--', ...selected)
                .split('\0')
                .filter(Boolean),
        );
        const result = spawnSync('vp', ['staged'], { stdio: 'inherit', windowsHide: true });
        if (result.error) throw result.error;

        // Keep formatter output within the files the author explicitly selected.
        // Restore only index entries; the author's working files are never replaced here.
        const after = stagedPaths();
        const extra = after.filter((path) => !selected.includes(path));
        if (extra.length) git('restore', '--staged', '--', ...extra);
        // Formatting a modification back to HEAD is a valid no-op. Only restore
        // disappeared additions/deletions, whose structural intent cannot be formatting.
        const missing = selected.filter(
            (path) => !after.includes(path) && (!entries.has(path) || !originalPaths.has(path)),
        );
        for (const path of missing) {
            const entry = entries.get(path);
            if (entry) git('update-index', '--add', '--cacheinfo', entry[0], entry[1], path);
            else git('update-index', '--force-remove', '--', path);
        }
        if (extra.length || missing.length)
            process.stderr.write(
                '提交范围保护：已还原检查工具额外改变的暂存范围，工作区内容保留。\n',
            );
        process.exitCode = result.status ?? 1;
    }
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
