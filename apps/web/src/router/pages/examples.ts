import type { RouteRecordRaw } from 'vue-router';

export default (import.meta.env.MODE === 'test'
    ? [
          {
              path: '/__examples/states',
              name: 'states-example',
              component: () => import('@/views/examples/StatesExample.vue'),
              meta: { title: '状态与交互样例' },
          },
          {
              path: '/__examples/source-images',
              name: 'source-images-example',
              component: () => import('@/views/examples/SourceImagesExample.vue'),
              meta: { title: '来源图片样例' },
          },
          {
              path: '/__examples/visual-foundation',
              name: 'visual-foundation-example',
              component: () => import('@/views/examples/VisualFoundationExample.vue'),
              meta: { title: '基础视觉样例' },
          },
      ]
    : []) satisfies RouteRecordRaw[];
