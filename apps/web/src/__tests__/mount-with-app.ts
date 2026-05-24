import { mount, type ComponentMountingOptions } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { Component } from 'vue';

/**
 * Mount a component with a fresh `QueryClient` (retries off, tiny gcTime so
 * tests don't share cache). Returns the wrapper + the client so individual
 * tests can `client.setQueryData(...)` to skip network entirely.
 *
 * Use this for any component that calls `useQuery` / `useMutation`. For
 * pure-presentational components (no vue-query, no router), call
 * `@vue/test-utils#mount` directly — no need for the wrapper.
 */
export function mountWithApp<T extends Component>(
  Comp: T,
  options: ComponentMountingOptions<T> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  const wrapper = mount(Comp, {
    ...options,
    global: {
      ...options.global,
      plugins: [...(options.global?.plugins ?? []), [VueQueryPlugin, { queryClient }]],
    },
  });

  return { wrapper, queryClient };
}
