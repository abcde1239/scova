import type { Component } from 'vue';
import type { RouteRecordRaw } from 'vue-router';

const pages = import.meta.glob<Component>('./pages/*.vue', { import: 'default' });

export default (import.meta.env.MODE === 'test'
    ? [
          {
              path: '/__examples/states',
              name: 'states-example',
              component: pages['./pages/StatesExample.vue'],
              meta: { title: '状态与交互样例' },
          },
          {
              path: '/__examples/source-images',
              name: 'source-images-example',
              component: pages['./pages/SourceImagesExample.vue'],
              meta: { title: '来源图片样例' },
          },
          {
              path: '/__examples/visual-foundation',
              name: 'visual-foundation-example',
              component: pages['./pages/VisualFoundationExample.vue'],
              meta: { title: '基础视觉样例' },
          },
      ]
    : []) satisfies RouteRecordRaw[];
