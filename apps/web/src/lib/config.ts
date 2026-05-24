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
};

/**
 * Fetch the config once (long-lived cache) and expose the flags. Until it
 * resolves — or if it fails — flags default to OFF so nothing agency-specific
 * is shown to a legacy operator by accident.
 */
export function useFlags() {
  const { data } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigResponse>('/config'),
    staleTime: Infinity,
    retry: false,
  });
  return computed<AppFlags>(() => data.value?.flags ?? DEFAULT_FLAGS);
}
