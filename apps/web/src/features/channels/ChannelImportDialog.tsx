import { useState, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import { Modal } from '../../components/Modal';
import { Textarea } from '../../components/Textarea';
import { Select } from '../../components/Select';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function ChannelImportDialog({ open, onClose, onDone }: Props) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [platformHint, setPlatformHint] = useState<'auto' | 'telegram' | 'instagram' | 'youtube'>('auto');
  const fileRef = useRef<HTMLInputElement>(null);

  const mut = useMutation({
    mutationFn: () => {
      const lines = text
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return api.post<{ accepted: number; skipped: number }>('/channels/import', {
        items: lines,
        platform_hint: platformHint === 'auto' ? undefined : platformHint,
      });
    },
    onSuccess: (r) => {
      toast.success('Импорт принят', `${r.accepted} новых, ${r.skipped} пропущено`);
      setText('');
      onDone();
    },
    onError: (e: Error) => toast.error('Ошибка импорта', e.message),
  });

  function onPickFile(): void {
    fileRef.current?.click();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then((t) => setText(t));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Импорт каналов"
      description="Каждая строка — handle (TG @x, IG instagram.com/y, YT youtube.com/@z) или ссылка."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mut.isPending}>
            Отмена
          </Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={!text.trim()}>
            Импортировать
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Select
            label="Платформа"
            value={platformHint}
            onChange={(e) => setPlatformHint(e.target.value as typeof platformHint)}
            options={[
              { value: 'auto', label: 'Авто-определение' },
              { value: 'telegram', label: 'Telegram' },
              { value: 'instagram', label: 'Instagram' },
              { value: 'youtube', label: 'YouTube' },
            ]}
          />
        </div>
        <div className="flex items-end">
          <Button
            variant="secondary"
            className="w-full"
            leftIcon={<ArrowUpTrayIcon className="h-4 w-4" />}
            onClick={onPickFile}
          >
            Загрузить CSV
          </Button>
          <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={onFile} />
        </div>
      </div>
      <Textarea
        className="mt-4"
        rows={10}
        fontMono
        label="Список (каждая строка — один канал)"
        placeholder={`@founders_diary\ninstagram.com/anya_travels\nhttps://youtube.com/@nosquare`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="mt-2 text-xs text-slate-500">
        Дубликаты по (platform, external_id) объединяются. Для тяжёлого импорта используйте API.
      </p>
    </Modal>
  );
}
