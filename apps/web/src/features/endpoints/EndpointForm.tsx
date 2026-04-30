import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from '../../components/Modal';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import type { LLMEndpoint } from './EndpointsPage';

interface Props {
  open: boolean;
  onClose: () => void;
  endpoint: LLMEndpoint | null;
  onSaved: () => void;
}

export function EndpointForm({ open, onClose, endpoint, onSaved }: Props) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<'yandex' | 'openrouter' | 'openai_compat'>('yandex');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [folderId, setFolderId] = useState('');
  const [iamToken, setIamToken] = useState('');
  const [rateLimit, setRateLimit] = useState<string>('');

  useEffect(() => {
    if (endpoint) {
      setName(endpoint.name);
      setProvider(endpoint.provider);
      setBaseUrl(endpoint.base_url);
      setApiKey('');
      setFolderId('');
      setIamToken('');
      setRateLimit(endpoint.rate_limit_rpm ? String(endpoint.rate_limit_rpm) : '');
    } else {
      setName('');
      setProvider('yandex');
      setBaseUrl(defaultBaseUrl('yandex'));
      setApiKey('');
      setFolderId('');
      setIamToken('');
      setRateLimit('');
    }
  }, [endpoint, open]);

  useEffect(() => {
    if (!endpoint) setBaseUrl(defaultBaseUrl(provider));
  }, [provider, endpoint]);

  const mut = useMutation({
    mutationFn: () => {
      const auth: Record<string, string> = {};
      if (apiKey) auth.api_key = apiKey;
      if (folderId) auth.folder_id = folderId;
      if (iamToken) auth.iam_token = iamToken;
      const body = {
        name,
        provider,
        base_url: baseUrl,
        auth: Object.keys(auth).length ? auth : undefined,
        rate_limit_rpm: rateLimit ? Number(rateLimit) : null,
      };
      if (endpoint) return api.patch<LLMEndpoint>(`/endpoints/${endpoint.id}`, body);
      return api.post<LLMEndpoint>('/endpoints', body);
    },
    onSuccess: () => {
      toast.success(endpoint ? 'Endpoint обновлён' : 'Endpoint создан');
      onSaved();
    },
    onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={endpoint ? 'Редактировать endpoint' : 'Новый LLM endpoint'}
      description="Ключи и токены шифруются перед записью в БД."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mut.isPending}>
            Отмена
          </Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={!name || !baseUrl}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Имя"
          placeholder="yandex-prod / openrouter-default"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          label="Провайдер"
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
          options={[
            { value: 'yandex', label: 'Yandex Foundation Models' },
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'openai_compat', label: 'OpenAI-compatible (self-hosted)' },
          ]}
        />
        <Input
          label="Base URL"
          placeholder="https://..."
          className="sm:col-span-2"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Input
          label="API Key"
          type="password"
          placeholder={endpoint ? '•••• оставьте пустым, чтобы не менять' : 'API key'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {provider === 'yandex' && (
          <>
            <Input
              label="Folder ID"
              placeholder="b1g..."
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
            />
            <Input
              label="IAM token (опционально)"
              type="password"
              value={iamToken}
              onChange={(e) => setIamToken(e.target.value)}
              className="sm:col-span-2"
              helpText="Если не указан — будет использован API key."
            />
          </>
        )}
        <Input
          label="Rate limit (RPM)"
          placeholder="например 60"
          type="number"
          value={rateLimit}
          onChange={(e) => setRateLimit(e.target.value)}
        />
      </div>
    </Modal>
  );
}

function defaultBaseUrl(provider: 'yandex' | 'openrouter' | 'openai_compat'): string {
  if (provider === 'yandex') return 'https://llm.api.cloud.yandex.net';
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1';
  return 'http://localhost:11434/v1';
}
