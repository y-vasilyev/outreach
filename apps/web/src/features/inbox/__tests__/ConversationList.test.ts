import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ConversationList from '../ConversationList.vue';
import type { ConversationListItem } from '../types';

const baseItem = (overrides: Partial<ConversationListItem>): ConversationListItem => ({
  id: 'conv',
  status: 'active',
  mode: 'assisted',
  contact: {
    id: 'contact',
    value: '@contact',
    channel: { title: 'Contact', handle: 'contact', platform: 'telegram' },
  },
  ...overrides,
});

describe('ConversationList quick filters', () => {
  it('filters the visible rows when quick-filter buttons are clicked', async () => {
    const wrapper = mount(ConversationList, {
      props: {
        items: [
          baseItem({
            id: 'conv-ai',
            pendingSuggestions: 2,
            contact: {
              id: 'contact-ai',
              value: '@ai',
              channel: { title: 'AI Draft', handle: 'ai', platform: 'telegram' },
            },
          }),
          baseItem({
            id: 'conv-op',
            mode: 'manual',
            contact: {
              id: 'contact-op',
              value: '@operator',
              channel: { title: 'Needs Operator', handle: 'operator', platform: 'telegram' },
            },
          }),
          baseItem({
            id: 'conv-plain',
            contact: {
              id: 'contact-plain',
              value: '@plain',
              channel: { title: 'Plain Dialog', handle: 'plain', platform: 'telegram' },
            },
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('AI Draft');
    expect(wrapper.text()).toContain('Needs Operator');
    expect(wrapper.text()).toContain('Plain Dialog');

    await wrapper.get('button[title="ai"]').trigger('click');
    expect(wrapper.text()).toContain('AI Draft');
    expect(wrapper.text()).not.toContain('Needs Operator');
    expect(wrapper.text()).not.toContain('Plain Dialog');
    expect(wrapper.get('button[title="ai"]').attributes('aria-pressed')).toBe('true');

    await wrapper.get('button[title="op"]').trigger('click');
    expect(wrapper.text()).not.toContain('AI Draft');
    expect(wrapper.text()).toContain('Needs Operator');
    expect(wrapper.text()).not.toContain('Plain Dialog');
    expect(wrapper.get('button[title="op"]').attributes('aria-pressed')).toBe('true');

    await wrapper.get('button[title="all"]').trigger('click');
    expect(wrapper.text()).toContain('AI Draft');
    expect(wrapper.text()).toContain('Needs Operator');
    expect(wrapper.text()).toContain('Plain Dialog');
  });

  it('shows operator-facing row stages for replies and waiting dialogs', () => {
    const wrapper = mount(ConversationList, {
      props: {
        items: [
          baseItem({
            id: 'conv-replied',
            lastInboundAt: '2026-06-05T10:00:00.000Z',
            lastReadAt: '2026-06-05T09:00:00.000Z',
            unread: 1,
            contact: {
              id: 'contact-replied',
              value: '@replied',
              channel: { title: 'Fresh Reply', handle: 'replied', platform: 'telegram' },
            },
          }),
          baseItem({
            id: 'conv-waiting',
            lastOutboundAt: '2026-06-05T10:30:00.000Z',
            contact: {
              id: 'contact-waiting',
              value: '@waiting',
              channel: { title: 'Waiting Blogger', handle: 'waiting', platform: 'telegram' },
            },
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('Fresh Reply');
    expect(wrapper.text()).toContain('ответил');
    expect(wrapper.text()).toContain('Waiting Blogger');
    expect(wrapper.text()).toContain('ждём ответ');
  });
});
