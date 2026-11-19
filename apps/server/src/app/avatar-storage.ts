import { createImageStorageView, type ImageStorage } from '@scova/object-storage/image';
import { createBucketStorage } from '@/app/object-storage';

/** Standalone compatibility factory. ApiServices owns the shared bucket instead. */
export function createAvatarStorage(env: NodeJS.ProcessEnv = process.env): ImageStorage | null {
    const bucket = createBucketStorage(env);
    if (!bucket) return null;
    return { ...createImageStorageView(bucket), destroy: () => bucket.destroy() };
}
