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

export function CampaignForm({ open, onClose, campaign, onSaved }: Props) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [valueProp, setValueProp] = useState('');
  const [mode, setMode] = useState<'auto' | 'assisted' | 'manual'>('assisted');
  const [filterJson, setFilterJson] = useState('{\n  "platform": ["telegram"],\n  "role_guess": ["ad_manager", "owner"]\n}');
  const [overridesJson, setOverridesJson] = useState('{}');
  const [scheduleJson, setScheduleJson] = useState(
    '{\n  "tz": "Europe/Moscow",\n  "work_hours": "10:00-19:00",\n  "days": ["mon","tue","wed","thu","fri"],\n  "max_per_day_per_account": 25\n}',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (campaign) {
      setName(campaign.name);
      setGoal(campaign.goal_text);
      setValueProp(campaign.value_prop);
      setMode(campaign.default_mode);
      setFilterJson(JSON.stringify(campaign.target_filter ?? {}, null, 2));
      setOverridesJson(JSON.stringify(campaign.agent_overrides ?? {}, null, 2));
      setScheduleJson(JSON.stringify(campaign.schedule ?? {}, null, 2));
    } else {
      setName('');
      setGoal('');
      setValueProp('');
      setMode('assisted');
    }
  }, [campaign, open]);

  const mut = useMutation({
    mutationFn: () => {
      let target_filter: unknown = {};
      let agent_overrides: unknown = {};
      let schedule: unknown = {};
      try {
        target_filter = JSON.parse(filterJson || '{}');
        agent_overrides = JSON.parse(overridesJson || '{}');
        schedule = JSON.parse(scheduleJson || '{}');
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
      const body = {
        name,
        goal_text: goal,
        value_prop: valueProp,
        default_mode: mode,
        target_filter,
        agent_overrides,
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
          label="Цель / goal_text"
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
            helpText="platform, role_guess, language, channel.analysis.topic, tags"
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
            helpText="tz, work_hours, days, лимиты на аккаунт"
          />
        </div>
      </div>

      {error && <div className="mt-4 text-xs text-rose-600">JSON: {error}</div>}
    </Modal>
  );
}
