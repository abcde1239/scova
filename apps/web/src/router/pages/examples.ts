import type { RouteRecordRaw } from 'vue-router';

export default (import.meta.env.MODE === 'test'
    ? [
          {
              path: '/__examples/states',
              name: 'states-example',
              component: () => import('@/views/examples/StatesExample.vue'),
              meta: { title: '状态与交互样例' },
          },
      ]
    : []) satisfies RouteRecordRaw[];
