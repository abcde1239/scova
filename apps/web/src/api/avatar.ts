import {
    AVATAR_MAX_BYTES,
    AVATAR_CONTENT_TYPES,
    AvatarStateSchema,
    AvatarVersionQuerySchema,
    SessionResponseSchema,
    type AvatarState,
    type AvatarVersionQuery,
    type SessionResponse,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';
import { apiUrl } from '@/api/config';

export function validateAvatarFile(value: unknown): Blob {
    if (!(value instanceof Blob) || !value.size || value.size > AVATAR_MAX_BYTES)
        throw new Error('请选择不超过5 MiB的图片');
    if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(value.type))
        throw new Error('请选择JPEG、PNG、GIF或WebP图片');
    return value;
}
export const avatarImageUrl = (version: string) =>
    apiUrl(`/me/avatar/${encodeURIComponent(version)}`);
export const avatarStateEndpoint = defineApiEndpoint<{ data: AvatarState }>({
    method: 'GET',
    path: '/me/avatar',
    validator: modelValidator(AvatarStateSchema),
});
export const uploadAvatarEndpoint = defineApiEndpoint<{
    body: Blob;
    query: AvatarVersionQuery;
    data: SessionResponse;
}>({
    method: 'PUT',
    path: '/me/avatar',
    inputValidators: {
        body: { parse: validateAvatarFile },
        query: modelValidator(AvatarVersionQuerySchema),
    },
    validator: modelValidator(SessionResponseSchema),
});
export const removeAvatarEndpoint = defineApiEndpoint<{
    query: AvatarVersionQuery;
    data: SessionResponse;
}>({
    method: 'DELETE',
    path: '/me/avatar',
    inputValidators: { query: modelValidator(AvatarVersionQuerySchema) },
    validator: modelValidator(SessionResponseSchema),
});
