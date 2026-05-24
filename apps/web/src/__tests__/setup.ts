import { enableAutoUnmount } from '@vue/test-utils';
import { afterEach } from 'vitest';

// Auto-unmount every wrapper after each test. Without this, components
// that schedule background work (e.g. vue-query's `refetchInterval` on
// DiscoveryBatchStatusPage) keep firing between tests and can race the
// API spy of the next test — flaky-test source #1 in CI.
enableAutoUnmount(afterEach);
