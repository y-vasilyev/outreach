import { describe, expect, it } from 'vitest';

import { mountWithApp } from '../../../__tests__/mount-with-app';
import MessageBubble from '../MessageBubble.vue';
import type { ChatMessage } from '../types';

function makeMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    direction: 'in_',
    sender: 'contact',
    text: 'пост 15000',
    createdAt: '2026-06-08T10:00:00.000Z',
    ...over,
  };
}

describe('MessageBubble — operator extraction controls', () => {
  it('shows the extraction-status label on an inbound message', () => {
    const { wrapper } = mountWithApp(MessageBubble, { props: { msg: makeMsg({ extractionStatus: 'ok' }) } });
    expect(wrapper.text()).toContain('извлечено');
  });

  it('emits `reanalyze` with the message id when the re-run button is clicked', async () => {
    const { wrapper } = mountWithApp(MessageBubble, { props: { msg: makeMsg({ extractionStatus: 'failed' }) } });
    expect(wrapper.text()).toContain('ошибка');
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('reanalyze')?.[0]).toEqual(['m1']);
  });

  it('does not show extraction controls on an outbound message', () => {
    const { wrapper } = mountWithApp(MessageBubble, {
      props: { msg: makeMsg({ direction: 'out_', sender: 'operator', extractionStatus: null }) },
    });
    expect(wrapper.text()).not.toContain('извлечено');
  });
});
