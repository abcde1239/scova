import {
    NoteCommandResponseSchema,
    NoteInputSchema,
    NoteListQuerySchema,
    NoteListResponseSchema,
    NotePatchInputSchema,
    NoteSchema,
    UuidSchema,
    parseContract,
    type LibraryTarget,
    type NoteInput,
    type NoteListQuery,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator, voidValidator } from '@/api/validator';
export type Note = ReturnType<typeof parseContract<typeof NoteSchema>>;
export type NoteTarget = LibraryTarget & { label: string };
const params = {
    parse(value: unknown) {
        return {
            noteId: parseContract(
                UuidSchema,
                value && typeof value === 'object' && 'noteId' in value ? value.noteId : undefined,
            ),
        };
    },
};
export const notesEndpoint = defineApiEndpoint<{
    query: NoteListQuery;
    data: { items: Note[]; nextCursor: string | null };
}>({
    method: 'GET',
    path: '/notes',
    inputValidators: {
        query: {
            parse(value: unknown) {
                const query = parseContract(NoteListQuerySchema, value);
                if (query.sourceId && query.reportId) throw new TypeError('只能选择一种笔记目标');
                return query;
            },
        },
    },
    validator: modelValidator(NoteListResponseSchema),
});
export const noteEndpoint = defineApiEndpoint<{ params: { noteId: string }; data: Note }>({
    method: 'GET',
    path: '/notes/:noteId',
    inputValidators: { params },
    validator: modelValidator(NoteSchema),
});
export const createNoteEndpoint = defineApiEndpoint<{
    body: NoteInput;
    data: { note: Note; reused: boolean };
}>({
    method: 'POST',
    path: '/notes',
    inputValidators: { body: modelValidator(NoteInputSchema) },
    validator: modelValidator(NoteCommandResponseSchema),
});
export const patchNoteEndpoint = defineApiEndpoint<{
    params: { noteId: string };
    body: { body: string };
    data: Note;
}>({
    method: 'PATCH',
    path: '/notes/:noteId',
    inputValidators: { params, body: modelValidator(NotePatchInputSchema) },
    validator: modelValidator(NoteSchema),
});
export const deleteNoteEndpoint = defineApiEndpoint<{ params: { noteId: string }; data: void }>({
    method: 'DELETE',
    path: '/notes/:noteId',
    inputValidators: { params },
    validator: voidValidator,
});
