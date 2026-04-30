import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from '../../components/Modal';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import type { UserRow } from './UsersPage';

interface Props {
  open: boolean;
  onClose: () => void;
  user: UserRow | null;
  onSaved: () => void;
}

export function UserForm({ open, onClose, user, onSaved }: Props) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('operator');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (user) {
      setEmail(user.email);
      setName(user.name ?? '');
      setRole(user.role);
      setPassword('');
    } else {
      setEmail('');
      setName('');
      setRole('operator');
      setPassword('');
    }
  }, [user, open]);

  const mut = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { email, name, role };
      if (password) body.password = password;
      if (user) return api.patch<UserRow>(`/users/${user.id}`, body);
      return api.post<UserRow>('/users', body);
    },
    onSuccess: () => {
      toast.success(user ? 'Пользователь обновлён' : 'Пользователь создан');
      onSaved();
    },
    onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={user ? 'Редактировать пользователя' : 'Новый пользователь'}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mut.isPending}>
            Отмена
          </Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={!email || (!user && !password)}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label="Имя" value={name} onChange={(e) => setName(e.target.value)} />
        <Select
          label="Роль"
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
          options={[
            { value: 'admin', label: 'admin — полный доступ' },
            { value: 'operator', label: 'operator — диалоги и кампании' },
            { value: 'viewer', label: 'viewer — только просмотр' },
          ]}
        />
        <Input
          label={user ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль'}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
    </Modal>
  );
}
