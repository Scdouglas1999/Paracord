import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IncomingCallBanner } from './IncomingCallBanner';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';
import type { VoiceState } from '../../types';

const call = vi.hoisted(() => ({
  current: null as null | { channelId: string; callerName: string; participantCount: number },
  decline: vi.fn(),
  joinChannel: vi.fn(),
}));

vi.mock('../../hooks/useIncomingDmCall', () => ({
  useIncomingDmCall: () => ({ call: call.current, decline: call.decline }),
}));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => ({ joinChannel: call.joinChannel }) }));
// A face draws its picture from an authenticated URL; the ticket is not this suite's business.
vi.mock('../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

function voiceState(userId: string, name: string): VoiceState {
  return { user_id: userId, channel_id: 'dm-1', username: name, self_mute: false, self_deaf: false } as unknown as VoiceState;
}

function renderBanner() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <IncomingCallBanner />
      <Routes>
        <Route path="/app" element={<div>Home</div>} />
        <Route path="/app/dms/:channelId" element={<div>DM route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  call.current = null;
  useAuthStore.setState({ user: { id: 'me', username: 'Sean' } as never });
  useVoiceStore.setState({ channelParticipants: new Map() });
});

describe('the incoming call notice', () => {
  it('renders nothing while nobody is calling', () => {
    renderBanner();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says who is calling, in the words the call pill would', () => {
    call.current = { channelId: 'dm-1', callerName: 'Brendan', participantCount: 2 };
    useVoiceStore.setState({ channelParticipants: new Map([['dm-1', [voiceState('52', 'Brendan')]]]) });
    renderBanner();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Brendan is calling you');
    // Live is amber; the words say it too.
    expect(alert).toHaveTextContent('Live call');
  });

  it('says a group is in a call when more than one person is', () => {
    call.current = { channelId: 'dm-1', callerName: 'Brendan, Nick', participantCount: 3 };
    renderBanner();
    expect(screen.getByRole('alert')).toHaveTextContent('Brendan, Nick are in a call');
  });

  it('shows the callers as faces, never yourself', () => {
    call.current = { channelId: 'dm-1', callerName: 'Brendan', participantCount: 2 };
    useVoiceStore.setState({
      channelParticipants: new Map([['dm-1', [voiceState('52', 'Brendan'), voiceState('me', 'Sean')]]]),
    });
    const { container } = renderBanner();
    expect(container.querySelectorAll('.glass-face')).toHaveLength(1);
    expect(container.querySelector('.glass-face')).toHaveTextContent('B');
  });

  it('answers in the conversation: Join opens it and joins the call', async () => {
    call.current = { channelId: 'dm-1', callerName: 'Brendan', participantCount: 2 };
    renderBanner();
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(call.joinChannel).toHaveBeenCalledWith('dm-1', 'dm');
    expect(await screen.findByText('DM route')).toBeInTheDocument();
  });

  it('makes Join the one cream button and Decline plain text, and declining is local', async () => {
    call.current = { channelId: 'dm-1', callerName: 'Brendan', participantCount: 2 };
    renderBanner();
    expect(screen.getByRole('button', { name: 'Join' })).toHaveClass('glass-btn--primary');
    const decline = screen.getByRole('button', { name: 'Decline' });
    expect(decline).toHaveClass('glass-btn--text');
    await act(async () => {
      await userEvent.click(decline);
    });
    expect(call.decline).toHaveBeenCalledTimes(1);
    expect(call.joinChannel).not.toHaveBeenCalled();
  });

  it('carries no green, and no literal color', () => {
    call.current = { channelId: 'dm-1', callerName: 'Brendan', participantCount: 2 };
    const { container } = renderBanner();
    const html = container.innerHTML;
    expect(html).not.toMatch(/accent-success|#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
