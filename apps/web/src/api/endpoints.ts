import {
    LoginInputSchema,
    SessionResponseSchema,
    UpdatePreferencesInputSchema,
    type LoginInput,
    type SessionResponse,
    type UpdatePreferencesInput,
} from '@scova/models';
import {
    defineEndpoint,
    identityCodec,
    type EndpointData,
    type EndpointOptions,
    type EndpointSpec,
    type Validator,
} from 'requestlane';
import { modelValidator, voidValidator } from '@/api/validator';

export function assertApiPath(path: string) {
    if (!/^\/(?!\/)[A-Za-z0-9_/:.-]*$/.test(path) || path.split('/').includes('..'))
        throw new TypeError('API 端点必须使用同源相对路径');
}

/** 领域模块在模块作用域定义端点；缓存统一交由 Vue Query。 */
export function defineApiEndpoint<S extends EndpointSpec>(
    options: Omit<EndpointOptions<S>, 'cache' | 'codec' | 'responseType'> & {
        validator: Validator<EndpointData<S>>;
    },
) {
    assertApiPath(options.path);
    return defineEndpoint<S>({
        ...options,
        cache: false,
        codec: identityCodec,
        responseType: 'json',
    });
}

export const currentSessionEndpoint = defineApiEndpoint<{ data: SessionResponse }>({
    method: 'GET',
    path: '/me',
    validator: modelValidator(SessionResponseSchema),
});

export const loginEndpoint = defineApiEndpoint<{ body: LoginInput; data: SessionResponse }>({
    method: 'POST',
    path: '/auth/login',
    anonymous: true,
    inputValidators: { body: modelValidator(LoginInputSchema) },
    validator: modelValidator(SessionResponseSchema),
});

export const logoutEndpoint = defineApiEndpoint<{ data: void }>({
    method: 'POST',
    path: '/auth/logout',
    validator: voidValidator,
});

export const updatePreferencesEndpoint = defineApiEndpoint<{
    body: UpdatePreferencesInput;
    data: SessionResponse;
}>({
    method: 'PATCH',
    path: '/me/preferences',
    inputValidators: { body: modelValidator(UpdatePreferencesInputSchema) },
    validator: modelValidator(SessionResponseSchema),
});
