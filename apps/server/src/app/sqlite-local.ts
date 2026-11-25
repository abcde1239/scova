import { isAbsolute, resolve } from 'node:path';
import { readSqliteStatePath } from '@scova/db/sqlite-state';

/** The full SQLite mode is opt-in and owns two local files. */
export function readLocalSqlitePaths(env: NodeJS.ProcessEnv = process.env) {
    const path = env.SCOVA_SQLITE_DATABASE_PATH;
    if (path === undefined) return undefined;
    if (!isAbsolute(path)) throw new Error('SCOVA_SQLITE_DATABASE_PATH 必须为本机绝对文件路径');
    if (env.DATABASE_URL || env.REDIS_URL)
        throw new Error('SQLite 本机模式要求 DATABASE_URL 和 REDIS_URL 为空');
    const business = resolve(path);
    const state = readSqliteStatePath(env);
    if (!state) throw new Error('SQLite 本机模式需要独立的 SCOVA_SQLITE_STATE_PATH');
    const samePath =
        process.platform === 'win32'
            ? state.toLowerCase() === business.toLowerCase()
            : state === business;
    if (samePath) throw new Error('SQLite 本机模式需要独立的 SCOVA_SQLITE_STATE_PATH');
    return { business, state };
}
