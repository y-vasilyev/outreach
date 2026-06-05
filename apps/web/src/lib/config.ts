import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from './api';

/**
 * Public feature-flag snapshot from the API (`GET /config`). The agency
 * sourcing & matching surfaces are flag-gated server-side (routes stay
 * unregistered when off); the web mirrors those flags here so it can hide nav
 * entries and controls entirely when a flag is off — keeping the operator
 * experience byte-for-byte legacy. Pages still keep their own FeatureOff
 * fallback for safety if a flag flips between fetch and navigation.
 */
export interface AppFlags {
  campaignTypes: boolean;
  agencySourcing: boolean;
  objectStorage: boolean;
  bloggerMatching: boolean;
  channelDiscovery: boolean;
  dataCollectionHud: boolean;
}

interface ConfigResponse {
  flags: AppFlags;
}

const DEFAULT_FLAGS: AppFlags = {
  campaignTypes: false,
  agencySourcing: false,
  objectStorage: false,
  bloggerMatching: false,
  channelDiscovery: false,
  dataCollectionHud: false,
};

/**
 * Fetch the public config and expose the flags. Until it resolves — or if it
 * fails — flags default to OFF so nothing agency-specific is shown to a legacy
 * operator by accident. The snapshot is refreshed periodically because flags
 * may be flipped from another tab/process while an operator keeps the inbox
 * open.
 */
export function useFlags() {
  const { data } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigResponse>('/config'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
  return computed<AppFlags>(() => data.value?.flags ?? DEFAULT_FLAGS);
}
