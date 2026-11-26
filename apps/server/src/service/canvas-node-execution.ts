import {
    workflowFileMaxBytes,
    REPORT_ATTACHMENT_MAX_CELL_CHARS,
    REPORT_ATTACHMENT_MAX_COLUMNS,
    REPORT_ATTACHMENT_MAX_ROWS,
    type WorkflowCanvasInput,
    type WorkflowCanvasNode,
    type WorkflowCanvasOutput,
} from '@scova/models';
import { ApiError } from '@/utils/errors';
import { parseReportCsv } from './report-csv.ts';

type CanvasNode = Exclude<WorkflowCanvasNode, { type: 'study' }>;
type Upstream = Readonly<Record<string, WorkflowCanvasOutput>>;
type Table = NonNullable<WorkflowCanvasOutput['table']>;
type CsvConfig = Extract<CanvasNode, { type: 'csv' }>['config'];
export type WorkflowGenerator = (args: {
    instructions: string;
    context: string;
    providerId: string | undefined;
}) => Promise<string>;

const maxBytes = workflowFileMaxBytes;
const maxNotificationFieldBytes = 8000 * 4;
// Filenames become download labels, so reject path separators and header control characters.
// oxlint-disable-next-line no-control-regex
const unsafeFilenameCharacters = /[/?<>\\:*|"\u0000-\u001F\u007F]/u;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

type CanvasNodeErrorCode =
    | 'MISSING_SOURCE'
    | 'INVALID_SOURCE'
    | 'INVALID_CSV'
    | 'INVALID_JSON'
    | 'JSON_LIMIT_EXCEEDED'
    | 'CSV_LIMIT_EXCEEDED'
    | 'INVALID_COLUMN'
    | 'INVALID_FILTER'
    | 'INVALID_TEMPLATE'
    | 'INVALID_ARTIFACT_FILENAME'
    | 'OUTPUT_LIMIT_EXCEEDED'
    | 'GENERATION_FAILED';

export class CanvasNodeError extends Error {
    constructor(
        readonly code: CanvasNodeErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'CanvasNodeError';
    }
}

function bound(value: string, limit = maxBytes): string {
    if (Buffer.byteLength(value) > limit)
        throw new CanvasNodeError('OUTPUT_LIMIT_EXCEEDED', '节点内容超过大小限制');
    return value;
}

function readSource(upstream: Upstream, id: string): WorkflowCanvasOutput {
    const output = Object.hasOwn(upstream, id) ? upstream[id] : undefined;
    if (!output) throw new CanvasNodeError('MISSING_SOURCE', '找不到绑定的上游节点输出');
    return output;
}

function templateValue(key: string, input: WorkflowCanvasInput, upstream: Upstream): unknown {
    if (key === 'threshold' || key === 'inventoryColumn' || key === 'period') return input[key];
    const [id, ...path] = key.split('.');
    if (!id || !path.length) return undefined;

    let value: unknown = Object.hasOwn(upstream, id) ? upstream[id] : undefined;
    for (const field of path) {
        if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            !Object.hasOwn(value, field)
        )
            return undefined;
        value = (value as Record<string, unknown>)[field];
    }
    return value;
}

function render(
    template: string,
    input: WorkflowCanvasInput,
    upstream: Upstream = {},
    limit = maxBytes,
): string {
    const parts: string[] = [];
    let remaining = limit;
    let offset = 0;
    function append(part: string) {
        bound(part, remaining);
        remaining -= Buffer.byteLength(part);
        parts.push(part);
    }
    for (const match of template.matchAll(/\{\{([^{}]*)\}\}/gu)) {
        const value = templateValue(match[1]!.trim(), input, upstream);
        if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
            throw new CanvasNodeError('INVALID_TEMPLATE', '模板变量缺失或不是可显示的值');
        append(template.slice(offset, match.index));
        append(String(value));
        offset = match.index + match[0].length;
    }
    append(template.slice(offset));
    return parts.join('');
}

function numberFromCsv(value: string): number | undefined {
    const trimmed = value.trim();
    if (!decimal.test(trimmed)) return undefined;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : undefined;
}

function readCsv(text: string): Table {
    if (Buffer.byteLength(text) > maxBytes)
        throw new CanvasNodeError('CSV_LIMIT_EXCEEDED', 'CSV 超过大小限制');
    const parsed = parseReportCsv(Buffer.from(text));
    if (parsed.status === 'failed') {
        if (parsed.failureCode === 'CSV_LIMIT_EXCEEDED')
            throw new CanvasNodeError('CSV_LIMIT_EXCEEDED', 'CSV 超过行数、列数或单元格限制');
        throw new CanvasNodeError('INVALID_CSV', 'CSV 格式无效');
    }
    const [header, ...rows] = parsed.rows;
    if (!header) throw new CanvasNodeError('INVALID_CSV', 'CSV 缺少表头');
    return { columns: header.cells, rows: rows.map((row) => row.cells) };
}

function readJson(text: string): unknown {
    if (Buffer.byteLength(text) > maxBytes)
        throw new CanvasNodeError('JSON_LIMIT_EXCEEDED', 'JSON 超过大小限制');
    try {
        return JSON.parse(text);
    } catch (cause) {
        throw new CanvasNodeError('INVALID_JSON', 'JSON 格式无效', { cause });
    }
}

export function validateWorkflowFileInput(input: WorkflowCanvasInput | undefined) {
    if (input?.json === undefined) return;
    if (input.csv !== undefined)
        throw new ApiError(422, 'WORKFLOW_INVALID_INPUT', '一次运行只能提供 CSV 或 JSON 文件');
    try {
        readJson(input.json);
    } catch (error) {
        if (!(error instanceof CanvasNodeError)) throw error;
        throw new ApiError(422, 'WORKFLOW_INVALID_JSON', error.message, [
            { path: '/input/json', message: error.message },
        ]);
    }
}

function jsonTable(text: string): Table {
    const records = readJson(text);
    if (!Array.isArray(records) || !records.length)
        throw new CanvasNodeError('INVALID_JSON', '整理表格需要非空的 JSON 对象数组');
    if (records.length >= REPORT_ATTACHMENT_MAX_ROWS)
        throw new CanvasNodeError('JSON_LIMIT_EXCEEDED', 'JSON 表格超过行数限制');

    const columns = new Set<string>();
    const cells = records.map((record: unknown) => {
        if (!record || typeof record !== 'object' || Array.isArray(record))
            throw new CanvasNodeError('INVALID_JSON', 'JSON 表格的每一行必须是对象');
        return new Map(
            Object.entries(record).map(([column, value]) => {
                columns.add(column);
                const cell =
                    value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
                if (
                    column.length > REPORT_ATTACHMENT_MAX_CELL_CHARS ||
                    cell.length > REPORT_ATTACHMENT_MAX_CELL_CHARS
                )
                    throw new CanvasNodeError('JSON_LIMIT_EXCEEDED', 'JSON 表格单元格过长');
                return [column, cell] as const;
            }),
        );
    });
    if (columns.size > REPORT_ATTACHMENT_MAX_COLUMNS)
        throw new CanvasNodeError('JSON_LIMIT_EXCEEDED', 'JSON 表格超过列数限制');
    const names = [...columns];
    return {
        columns: names,
        rows: cells.map((row) => names.map((column) => row.get(column) ?? '')),
    };
}

function csvTable(source: WorkflowCanvasOutput): Table {
    if (source.table) return source.table;
    if (source.json !== undefined) return jsonTable(source.json);
    if (source.artifact?.format === 'json') return jsonTable(source.artifact.content);
    if (source.artifact?.format === 'csv') return readCsv(source.artifact.content);
    if (source.text !== undefined) return readCsv(source.text);
    throw new CanvasNodeError('INVALID_SOURCE', '整理表格节点需要表格、CSV 文本或 JSON 对象数组');
}

function csvFilter(
    column: number,
    operator: CsvConfig['filters'][number]['operator'],
    value: string,
) {
    if (operator === 'equals') return (row: string[]) => row[column] === value;
    if (operator === 'notEquals') return (row: string[]) => row[column] !== value;
    const operand = numberFromCsv(value);
    if (operand === undefined)
        throw new CanvasNodeError('INVALID_FILTER', '数值筛选条件需要有限的十进制数');
    return (row: string[]) => {
        const cell = numberFromCsv(row[column] ?? '');
        return cell !== undefined && (operator === 'lessThan' ? cell < operand : cell > operand);
    };
}

function executeCsv(
    config: CsvConfig,
    input: WorkflowCanvasInput,
    upstream: Upstream,
): WorkflowCanvasOutput {
    const table = csvTable(
        config.source === undefined
            ? { text: input.csv, json: input.json }
            : readSource(upstream, config.source),
    );
    if (
        !table.columns.length ||
        table.columns.some((name) => !name.trim()) ||
        new Set(table.columns).size !== table.columns.length
    )
        throw new CanvasNodeError('INVALID_COLUMN', '表格需要非空且唯一的列名');

    function columnIndex(name: string) {
        const index = table.columns.indexOf(name);
        if (index < 0) throw new CanvasNodeError('INVALID_COLUMN', '表格中找不到指定列');
        return index;
    }
    const filters = config.filters.map(({ column, operator, value }) =>
        csvFilter(columnIndex(render(column, input)), operator, render(value, input)),
    );
    const columns = config.columns?.length
        ? config.columns.map((column) => render(column, input))
        : table.columns;
    if (new Set(columns).size !== columns.length)
        throw new CanvasNodeError('INVALID_COLUMN', '表格投影中的列名必须唯一');
    const indices = columns.map(columnIndex);
    const rows = table.rows
        .filter((row) => filters.every((filter) => filter(row)))
        .map((row) => indices.map((index) => row[index]!));
    return { table: { columns: [...columns], rows }, count: rows.length };
}

function encodeCsv(table: Table): string {
    function record(row: string[]): string {
        return row
            .map((cell) => (/[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
            .join(',');
    }
    return [table.columns, ...table.rows].map(record).join('\r\n') + '\r\n';
}

async function runNode(
    node: CanvasNode,
    input: WorkflowCanvasInput,
    upstream: Upstream,
    generate: WorkflowGenerator,
): Promise<WorkflowCanvasOutput> {
    switch (node.type) {
        case 'start': {
            const text = input.text ?? input.csv;
            return {
                ...(text === undefined ? {} : { text }),
                ...(input.json === undefined ? {} : { json: input.json }),
            };
        }
        case 'merge':
        case 'end':
            // The scheduler passes named ancestors through the dependency gate.
            return {};
        case 'csv':
            return executeCsv(node.config, input, upstream);
        case 'generate': {
            const { sources } = node.config;
            const instructions = render(node.config.instructions, input);
            if (!instructions.trim())
                throw new CanvasNodeError('INVALID_TEMPLATE', '生成节点需要填写提示词');
            const context = bound(
                JSON.stringify(
                    sources.map((nodeId) => ({
                        nodeId,
                        output: readSource(upstream, nodeId),
                    })),
                ),
            );
            let text: string;
            try {
                text = await generate({ instructions, context, providerId: input.providerId });
            } catch (cause) {
                if (cause instanceof ApiError || cause instanceof CanvasNodeError) throw cause;
                throw new CanvasNodeError('GENERATION_FAILED', '工作流生成失败', { cause });
            }
            if (typeof text !== 'string' || !text.trim())
                throw new CanvasNodeError('GENERATION_FAILED', '模型未返回 Markdown 正文');
            return { text };
        }
        case 'deliver': {
            const { source, format } = node.config;
            const filename = render(node.config.filename, input, {}, 180 * 4);
            if (
                !filename.trim() ||
                filename.length > 180 ||
                unsafeFilenameCharacters.test(filename) ||
                ['.', '..'].includes(filename.trim())
            )
                throw new CanvasNodeError('INVALID_ARTIFACT_FILENAME', '交付文件名无效');
            const output = readSource(upstream, source);
            let content = output.artifact?.format === format ? output.artifact.content : undefined;
            if (format === 'csv' && output.table) content = encodeCsv(output.table);
            if (format === 'markdown' && !output.artifact) content = output.text;
            if (format === 'json' && !output.artifact) {
                if (output.table) {
                    const { columns, rows } = output.table;
                    content = JSON.stringify(
                        rows.map((row) =>
                            Object.fromEntries(
                                columns.map((column, index) => [column, row[index]]),
                            ),
                        ),
                    );
                } else {
                    content = output.json ?? output.text;
                }
            }
            if (format === 'json' && content !== undefined) readJson(content);
            if (content === undefined)
                throw new CanvasNodeError('INVALID_SOURCE', '上游输出与所选交付格式不匹配');
            return { artifact: { filename, format, content } };
        }
        case 'notify': {
            if (input.notify === false) return {};
            const { source, title, body } = node.config;
            const renderedTitle = render(title, input, upstream, maxNotificationFieldBytes);
            if (!renderedTitle.trim())
                throw new CanvasNodeError('INVALID_TEMPLATE', '通知节点需要填写标题');
            const notification: NonNullable<WorkflowCanvasOutput['notification']> = {
                title: renderedTitle,
                body: render(body, input, upstream, maxNotificationFieldBytes),
            };
            if (source !== undefined && readSource(upstream, source).artifact)
                notification.artifactNodeId = source;
            return { notification };
        }
    }
}

export async function executeCanvasNode(
    node: CanvasNode,
    input: WorkflowCanvasInput,
    upstream: Upstream,
    generate: WorkflowGenerator,
): Promise<WorkflowCanvasOutput> {
    const output = await runNode(node, input, upstream, generate);
    // A JSON file is bounded by its UTF-8 bytes. Storage escaping should not reduce its file limit.
    const artifact =
        output.artifact?.format === 'json' ? { ...output.artifact, content: '' } : output.artifact;
    if (output.json !== undefined) bound(output.json);
    bound(JSON.stringify({ ...output, json: undefined, artifact }));
    return output;
}
