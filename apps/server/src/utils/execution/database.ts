/** Assert a row returned by a required native query or RETURNING clause. */
export function requiredDatabaseValue<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error('预期数据库记录不存在');
    return value;
}
