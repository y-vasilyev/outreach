import { Badge } from '../../components/Badge';

interface Props {
  mode: 'auto' | 'assisted' | 'manual';
}

export function ModeBadge({ mode }: Props) {
  const tone = mode === 'auto' ? 'indigo' : mode === 'assisted' ? 'violet' : 'amber';
  return <Badge tone={tone}>{mode}</Badge>;
}
