import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from '../../components/Modal';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { Textarea } from '../../components/Textarea';
import { Button } from '../../components/Button';
import { api } from '../../lib/api';
import { useToast } from '../../components/Toast';
import type { TgAccount } from './TgAccountsPage';

interface Props {
  open: boolean;
  onClose: () => void;
  account: TgAccount | null;
  onSaved: (acc: TgAccount | null) => void;
}

export function TgAccountForm({ open, onClose, account, onSaved }: Props) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'parser' | 'outreach' | 'both'>('outreach');
  const [dailyMsgLimit, setDailyMsgLimit] = useState(40);
  const [dailyNewLimit, setDailyNewLimit] = useState(15);
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (account) {
      setLabel(account.label);
      setPhone(account.phone);
      setRole(account.role);
      setDailyMsgLimit(account.dailyMsgLimit);
      setDailyNewLimit(account.dailyNewContactLimit);
      setTags((account.tags ?? []).join(', '));
      setNotes(account.notes ?? '');
    } else {
      setLabel('');
      setPhone('');
      setRole('outreach');
      setDailyMsgLimit(40);
      setDailyNewLimit(15);
      setTags('');
      setNotes('');
    }
  }, [account, open]);

  const mut = useMutation({
    mutationFn: async (): Promise<TgAccount> => {
      const body = {
        label,
        phone,
        role,
        dailyMsgLimit,
        dailyNewContactLimit: dailyNewLimit,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes: notes || undefined,
      };
      if (account) return api.patch<TgAccount>(`/tg-accounts/${account.id}`, body);
      return api.post<TgAccount>('/tg-accounts', body);
    },
    onSuccess: (acc) => {
      toast.success(account ? 'Аккаунт сохранён' : 'Аккаунт создан');
      onSaved(acc);
    },
    onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={account ? 'Редактировать TG аккаунт' : 'Новый TG аккаунт'}
      description="После сохранения откроется мастер логина по номеру."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mut.isPending}>
            Отмена
          </Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input label="Метка" placeholder="parser-01 / outreach-team" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Input label="Номер" placeholder="+7..." value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Select
          label="Роль"
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
          options={[
            { value: 'parser', label: 'Парсер (только скрейп)' },
            { value: 'outreach', label: 'Outreach (отправка)' },
            { value: 'both', label: 'Both (универсальный)' },
          ]}
        />
        <Input
          label="Тэги"
          placeholder="ru, b2b, …"
          helpText="Через запятую"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <Input
          label="Лимит сообщений в день"
          type="number"
          value={dailyMsgLimit}
          onChange={(e) => setDailyMsgLimit(Number(e.target.value) || 0)}
        />
        <Input
          label="Лимит новых контактов в день"
          type="number"
          value={dailyNewLimit}
          onChange={(e) => setDailyNewLimit(Number(e.target.value) || 0)}
        />
      </div>
      <div className="mt-4">
        <Textarea label="Заметки" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Modal>
  );
}
