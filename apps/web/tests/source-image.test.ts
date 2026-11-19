import { describe, expect, it } from 'vite-plus/test';
import { displayImage } from '@/utils/source/image';

const image = { src: '/assets/map.svg', alt: '流域概念图', attribution: '自制', concept: true };

describe('来源图片展示输入', () => {
    it('缺图时保持 undefined，不猜测来源地址', () => {
        expect(displayImage()).toBeUndefined();
    });
    it('保留同源输入的长 alt、出处与概念图身份', () => {
        expect(displayImage(image)).toBe(image);
    });
    it.each([
        'https://external.invalid/map.jpg',
        '//external.invalid/map.jpg',
        '/\\external.invalid/map.jpg',
        'data:image/svg+xml,test',
        'blob:example',
        'relative.jpg',
        '/map\n.jpg',
    ])('不装载非同源根路径或含控制字符的输入：%s', (src) => {
        expect(displayImage({ ...image, src })).toBeUndefined();
    });
    it.each(['alt', 'attribution'] as const)('缺少 %s 时不展示无说明图片', (key) => {
        expect(displayImage({ ...image, [key]: ' ' })).toBeUndefined();
    });
});
