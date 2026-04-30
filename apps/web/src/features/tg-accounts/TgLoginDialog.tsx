import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircleIcon, KeyIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import { Modal } from '../../components/Modal';
import { Input } from '../../components/Input';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { TgAccount } from './TgAccountsPage';

type Step = 'phone' | 'code' | 'password' | 'done';

interface Props {
  open: boolean;
  onClose: () => void;
  account: TgAccount;
  onDone: () => void;
}

export function TgLoginDialog({ open, onClose, account, onDone }: Props) {
  const toast = useToast();
  const [step, setStep] = useState<Step>('phone');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  const startMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/tg-accounts/${account.id}/login/start`, {}),
    onSuccess: () => {
      setStep('code');
      toast.info('Код отправлен в Telegram');
    },
    onError: (e: Error) => toast.error('Не удалось начать вход', e.message),
  });

  const codeMut = useMutation({
    mutationFn: () =>
      api.post<{ ok?: boolean; needs2FA?: boolean }>(`/tg-accounts/${account.id}/login/confirm-code`, {
        code,
      }),
    onSuccess: (r) => {
      if (r.needs2FA) {
        setStep('password');
        toast.info('Введите пароль 2FA');
      } else {
        setStep('done');
        toast.success('Аккаунт авторизован');
      }
    },
    onError: (e: Error) => toast.error('Неверный код', e.message),
  });

  const pwdMut = useMutation({
    mutationFn: () => api.post<void>(`/tg-accounts/${account.id}/login/confirm-password`, { password }),
    onSuccess: () => {
      setStep('done');
      toast.success('Аккаунт авторизован');
    },
    onError: (e: Error) => toast.error('Неверный пароль', e.message),
  });

  function reset(): void {
    setStep('phone');
    setCode('');
    setPassword('');
  }

  function handleClose(): void {
    reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Вход: ${account.label} (${account.phone})`}
      description="3 шага: код по SMS / в Telegram → 2FA-пароль (если есть) → готово."
      size="md"
      footer={
        step === 'done' ? (
          <Button onClick={() => { onDone(); reset(); }}>Готово</Button>
        ) : (
          <Button variant="secondary" onClick={handleClose}>
            Отмена
          </Button>
        )
      }
    >
      <Stepper step={step} />
      <div className="mt-6 space-y-4">
        {step === 'phone' && (
          <div>
            <p className="text-sm text-slate-600">
              Отправим код подтверждения на <span className="font-medium text-slate-900">{account.phone}</span> в Telegram.
            </p>
            <Button className="mt-4" onClick={() => startMut.mutate()} loading={startMut.isPending}>
              Отправить код
            </Button>
          </div>
        )}
        {step === 'code' && (
          <div className="space-y-3">
            <Input
              label="Код из Telegram"
              autoFocus
              placeholder="12345"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={8}
            />
            <Button onClick={() => codeMut.mutate()} loading={codeMut.isPending} disabled={code.length < 4}>
              Подтвердить код
            </Button>
          </div>
        )}
        {step === 'password' && (
          <div className="space-y-3">
            <Input
              label="Пароль 2FA"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button onClick={() => pwdMut.mutate()} loading={pwdMut.isPending} disabled={!password}>
              Подтвердить пароль
            </Button>
          </div>
        )}
        {step === 'done' && (
          <div className="flex items-center gap-3 rounded-xl bg-emerald-50 p-4 text-emerald-700 ring-1 ring-emerald-200">
            <CheckCircleIcon className="h-5 w-5" />
            <div>
              <div className="text-sm font-semibold">Аккаунт {account.label} успешно авторизован</div>
              <div className="text-xs">Сессия зашифрована и сохранена в базе.</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: { key: Step; label: string; icon: typeof KeyIcon }[] = [
    { key: 'phone', label: 'Номер', icon: KeyIcon },
    { key: 'code', label: 'Код', icon: ShieldCheckIcon },
    { key: 'password', label: '2FA', icon: ShieldCheckIcon },
    { key: 'done', label: 'Готово', icon: CheckCircleIcon },
  ];
  const order: Record<Step, number> = { phone: 0, code: 1, password: 2, done: 3 };
  return (
    <ol className="flex items-center gap-2 text-xs font-medium">
      {steps.map((s, idx) => {
        const active = step === s.key;
        const passed = order[step] > idx;
        const Icon = s.icon;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full ring-1',
                active
                  ? 'bg-brand-600 text-white ring-brand-600'
                  : passed
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : 'bg-slate-50 text-slate-400 ring-slate-200',
              )}
            >
              <Icon className="h-4 w-4" />
            </div>
            <span
              className={cn(
                'truncate',
                active ? 'text-slate-900' : passed ? 'text-emerald-700' : 'text-slate-400',
              )}
            >
              {s.label}
            </span>
            {idx < steps.length - 1 && (
              <span className={cn('h-px flex-1', passed ? 'bg-emerald-200' : 'bg-slate-200')} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
