import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from '../../components/Modal';
import { Input } from '../../components/Input';
import { Textarea } from '../../components/Textarea';
import { Select } from '../../components/Select';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import type { Campaign } from './CampaignsPage';

interface Props {
  open: boolean;
  onClose: () => void;
  campaign: Campaign | null;
  onSaved: () => void;
}

const DEFAULT_FILTER_JSON = JSON.stringify(
  { platforms: ['telegram'], roleGuess: ['ad_manager', 'owner'] },
  null,
  2,
);
const DEFAULT_OVERRIDES_JSON = '{}';
const DEFAULT_SCHEDULE_JSON = JSON.stringify(
  {
    tz: 'Europe/Moscow',
    workHours: { start: '10:00', end: '20:00' },
    days: [1, 2, 3, 4, 5],
    maxPerDayPerAccount: 25,
  },
  null,
  2,
);

export function CampaignForm({ open, onClose, campaign, onSaved }: Props) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [valueProp, setValueProp] = useState('');
  const [mode, setMode] = useState<'auto' | 'assisted' | 'manual'>('assisted');
  const [filterJson, setFilterJson] = useState(DEFAULT_FILTER_JSON);
  const [overridesJson, setOverridesJson] = useState(DEFAULT_OVERRIDES_JSON);
  const [scheduleJson, setScheduleJson] = useState(DEFAULT_SCHEDULE_JSON);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (campaign) {
      setName(campaign.name);
      setGoal(campaign.goalText);
      setValueProp(campaign.valueProp);
      setMode(campaign.defaultMode);
      setFilterJson(JSON.stringify(campaign.targetFilter ?? {}, null, 2));
      setOverridesJson(JSON.stringify(campaign.agentOverrides ?? {}, null, 2));
      setScheduleJson(JSON.stringify(campaign.schedule ?? {}, null, 2));
    } else {
      setName('');
      setGoal('');
      setValueProp('');
      setMode('assisted');
      setFilterJson(DEFAULT_FILTER_JSON);
      setOverridesJson(DEFAULT_OVERRIDES_JSON);
      setScheduleJson(DEFAULT_SCHEDULE_JSON);
    }
    setError(null);
  }, [campaign, open]);

  const mut = useMutation({
    mutationFn: () => {
      let targetFilter: unknown = {};
      let agentOverrides: unknown = {};
      let schedule: unknown = {};
      try {
        targetFilter = JSON.parse(filterJson || '{}');
        agentOverrides = JSON.parse(overridesJson || '{}');
        schedule = JSON.parse(scheduleJson || '{}');
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
      const body = {
        name,
        goalText: goal,
        valueProp,
        defaultMode: mode,
        targetFilter,
        agentOverrides,
        schedule,
      };
      if (campaign) return api.patch<Campaign>(`/campaigns/${campaign.id}`, body);
      return api.post<Campaign>('/campaigns', body);
    },
    onSuccess: () => {
      toast.success(campaign ? 'Кампания обновлена' : 'Кампания создана');
      onSaved();
    },
    onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={campaign ? 'Редактировать кампанию' : 'Новая кампания'}
      description="Цель — CustDev. SafetyFilter блокирует продажные формулировки автоматически."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mut.isPending}>
            Отмена
          </Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={!name || !goal || !valueProp}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Название"
          placeholder="CustDev — B2B SaaS Q2"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          label="Default mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
          options={[
            { value: 'auto', label: 'auto — ИИ отправляет сам (low-risk)' },
            { value: 'assisted', label: 'assisted — оператор подтверждает' },
            { value: 'manual', label: 'manual — оператор пишет сам' },
          ]}
        />
        <Textarea
          label="Цель / goalText"
          rows={3}
          placeholder="20 минут CustDev по продукту X с фаундерами B2B SaaS"
          className="sm:col-span-2"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <Textarea
          label="Value-prop (что получит респондент)"
          rows={2}
          placeholder="доступ к бете / $30 / итоговый отчёт по индустрии"
          className="sm:col-span-2"
          value={valueProp}
          onChange={(e) => setValueProp(e.target.value)}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div>
          <Textarea
            label="Target filter (JSON)"
            fontMono
            rows={10}
            value={filterJson}
            onChange={(e) => setFilterJson(e.target.value)}
            helpText="platforms, roleGuess, languages, topics, tags, minConfidence"
          />
        </div>
        <div>
          <Textarea
            label="Agent overrides (JSON)"
            fontMono
            rows={10}
            value={overridesJson}
            onChange={(e) => setOverridesJson(e.target.value)}
            helpText="{ opening_composer: { params: { temperature: 0.4 }}}"
          />
        </div>
        <div>
          <Textarea
            label="Schedule (JSON)"
            fontMono
            rows={10}
            value={scheduleJson}
            onChange={(e) => setScheduleJson(e.target.value)}
            helpText="tz, workHours: {start,end}, days: [1..5] (0=вс), maxPerDayPerAccount"
          />
        </div>
      </div>

      {error && <div className="mt-4 text-xs text-rose-600">JSON: {error}</div>}
    </Modal>
  );
}
