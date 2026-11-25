import { workflowFileMaxBytes } from '@scova/models';

export async function readWorkflowInputFile(file: File, format: 'csv' | 'json') {
    const text = await readWorkflowTextFile(file, format.toUpperCase(), workflowFileMaxBytes);
    if (format === 'json') {
        try {
            JSON.parse(text);
        } catch {
            throw new Error('JSON 格式无效，请检查文件内容');
        }
    }
    return text;
}

export async function readWorkflowTextFile(file: File, label: string, maxBytes: number) {
    if (file.size > maxBytes) throw new Error(`${label} 文件不能超过 ${maxBytes / 1024} KiB`);
    const bytes = await file.arrayBuffer();
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`请使用 UTF-8 编码的 ${label} 文件`);
    }
}
