import { useState, type FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Input } from '../../components/Input';
import { Button } from '../../components/Button';
import { useAuth } from '../../lib/auth';
import { ApiError } from '../../lib/api';
import { useToast } from '../../components/Toast';

export function LoginPage() {
  const { login, user, isReady } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState('admin@nosquare.local');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isReady && user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      nav('/', { replace: true });
    } catch (err) {
      const ae = err as ApiError;
      setError(ae.message || 'Не удалось войти');
      toast.error('Ошибка входа', ae.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-brand-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-600 text-base font-bold text-white shadow-pop">
            N
          </div>
          <div className="text-lg font-semibold text-slate-900">Nosquare Outreach</div>
        </div>
        <div className="card-padded">
          <div className="text-center">
            <h1 className="text-xl font-semibold text-slate-900">Вход в админку</h1>
            <p className="mt-1 text-sm text-slate-500">Используйте корпоративный email и пароль</p>
          </div>
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <Input
              label="Email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <Input
              label="Пароль"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              error={error ?? undefined}
            />
            <Button type="submit" loading={submitting} className="w-full" size="lg">
              Войти
            </Button>
          </form>
          <p className="mt-4 text-center text-xs text-slate-400">
            Забыли пароль? Обратитесь к администратору.
          </p>
        </div>
      </div>
    </div>
  );
}
