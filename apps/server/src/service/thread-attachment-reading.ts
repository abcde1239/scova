import { parseContract } from '@scova/models';
import { threadAttachmentReadsSchema } from '@/model/thread-attachment-reading.ts';
import type {
    createThreadAttachmentService,
    resolveThreadAttachmentContext,
} from '@/service/thread-attachments.ts';

const maxLines = 6;
const maxLineChars = 240;
type Attachments = Awaited<ReturnType<typeof resolveThreadAttachmentContext>>;
type LookupContext = {
    userId: string;
    threadId: string;
    attachments: Attachments;
    signal: AbortSignal;
};

function lineSnippet(text: string, index: number) {
    const chars = Array.from(text);
    if (chars.length <= maxLineChars) return { text, truncated: false };
    const matchOffset = Array.from(text.slice(0, index)).length;
    const start = Math.min(Math.max(0, matchOffset - 40), chars.length - maxLineChars);
    return { text: chars.slice(start, start + maxLineChars).join(''), truncated: true };
}

export async function readThreadAttachmentEvidence(
    download: ReturnType<typeof createThreadAttachmentService>['download'],
    { userId, threadId, attachments, signal }: LookupContext,
    input: unknown,
) {
    const commands = parseContract(threadAttachmentReadsSchema, input);
    const authorized = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    const documents = new Map<string, string[] | null>();
    await Promise.all(
        [...new Set(commands.map(({ attachmentId }) => attachmentId))].map(async (id) => {
            if (!authorized.has(id)) return;
            try {
                const { body } = await download(userId, threadId, id, signal);
                const original = await new Response(body).arrayBuffer();
                const lines = new TextDecoder('utf-8', { fatal: true })
                    .decode(original)
                    .split(/\r\n|\r|\n/u);
                if (lines.at(-1) === '') lines.pop();
                signal.throwIfAborted();
                documents.set(id, lines);
            } catch {
                signal.throwIfAborted();
                documents.set(id, null);
            }
        }),
    );
    return commands.map(({ attachmentId, operation, startLine, query }, index) => {
        const attachment = authorized.get(attachmentId);
        const lines = documents.get(attachmentId);
        const filename = attachment?.filename;
        if (!lines || !filename) return { status: 'unavailable' as const, filename };
        let match = -1;
        let column = 0;
        let start = startLine - 1;
        if (operation === 'search') {
            const term = query.trim();
            if (!term) return { status: 'not_found' as const, filename };
            const literal = new RegExp(term.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&'), 'iu');
            match = lines.findIndex((line) => {
                const result = literal.exec(line);
                if (!result) return false;
                column = result.index;
                return true;
            });
            if (match < 0) return { status: 'not_found' as const, filename };
            start = Math.max(0, match - 2);
        }
        if (start >= lines.length) return { status: 'not_found' as const, filename };
        const end = Math.min(start + maxLines, lines.length);
        return {
            status: 'found' as const,
            citationId: index + 1,
            filename,
            startLine: start + 1,
            endLine: end,
            lines: lines.slice(start, end).map((line, offset) => ({
                line: start + offset + 1,
                ...lineSnippet(line, start + offset === match ? column : 0),
            })),
        };
    });
}
