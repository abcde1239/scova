/** 要求受既有业务前置条件保护的单行操作确实返回记录。 */
export function requireRow<T>(row: T | undefined): T {
    if (row === undefined) throw new Error('预期数据库记录不存在');
    return row;
}

export function firstRow<T>(rows: T[]): T {
    return requireRow(rows[0]);
}
