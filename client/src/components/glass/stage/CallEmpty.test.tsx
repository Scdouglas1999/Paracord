import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CallEmpty, callColumns, callFaceSize } from './CallEmpty';
import { callNotice } from './CallStage';
import type { StageModel, StagePerson } from './stageModel';

vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:face') },
}));

function person(userId: string, over: Partial<StagePerson> = {}): StagePerson {
  return {
    userId,
    name: userId[0].toUpperCase() + userId.slice(1),
    avatar: null,
    self: false,
    talking: false,
    muted: false,
    listening: false,
    sharing: false,
    camera: false,
    ...over,
  } as StagePerson;
}

function renderEmpty(people: StagePerson[], over: Partial<Parameters<typeof CallEmpty>[0]> = {}) {
  const onSwitch = vi.fn();
  render(
    <CallEmpty
      people={people}
      name="Game Night Lounge"
      line="No one is sharing"
      realVoice={false}
      phone={false}
      onSwitch={onSwitch}
      {...over}
    />,
  );
  return { onSwitch };
}

describe('CallEmpty', () => {
  it('draws everyone as a face with a name, in a list, with the call and what is not happening under it', () => {
    renderEmpty([person('brendan'), person('nick', { muted: true }), person('you', { self: true, name: 'You' })]);
    const list = screen.getByRole('list', { name: 'People in the call' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('.glass-call-empty__person-who')?.textContent)).toEqual([
      'Brendan',
      'Nick',
      'You',
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('No one is sharing');
    // The call's name is the large line under the faces; the title row says it to a screen reader.
    expect(document.querySelector('.glass-call-empty__name')).toHaveTextContent('Game Night Lounge');
    expect(document.querySelector('.glass-call-empty__name')).toHaveAttribute('aria-hidden', 'true');
  });

  it('rings the talker in amber, with the waveform beside their name, and says nothing odd about everyone else', () => {
    renderEmpty([person('brendan', { talking: true }), person('nick')], { realVoice: true });
    const [brendan, nick] = screen.getAllByRole('listitem');
    expect(brendan).toHaveAttribute('data-ring', 'amber');
    expect(brendan).toHaveAttribute('data-talking', 'true');
    const wave = brendan.querySelector('.glass-call-empty__wave');
    expect(wave).not.toBeNull();
    expect(wave).toHaveAttribute('data-real');
    expect(wave).toHaveAttribute('data-motion-speaking', 'brendan');
    expect(brendan).toHaveTextContent('Talking');
    expect(nick).toHaveAttribute('data-ring', 'faint');
    expect(nick.querySelector('.glass-call-empty__wave')).toBeNull();
    // "Mic on" is what everyone is: it is said to a screen reader, not drawn.
    expect(nick.querySelector('.glass-call-empty__state')).toBeNull();
    expect(nick.querySelector('.sr-only')).toHaveTextContent(/Mic on|,/);
  });

  it('marks who is muted with a badge on the face and in words', () => {
    renderEmpty([person('nick', { muted: true })]);
    const nick = screen.getByRole('listitem');
    expect(nick.querySelector('.glass-call-empty__mic')).not.toBeNull();
    expect(nick).toHaveTextContent('Muted');
  });

  it('a listener has no mic badge: they are listening in, not muted', () => {
    renderEmpty([person('lea', { listening: true, muted: true })]);
    const lea = screen.getByRole('listitem');
    expect(lea.querySelector('.glass-call-empty__mic')).toBeNull();
    expect(lea).toHaveTextContent('Listening in');
  });

  it("someone else's screen opens from their face, ringed in amber; yours never does", () => {
    const { onSwitch } = renderEmpty([
      person('vincent', { sharing: true }),
      person('you', { self: true, name: 'You', sharing: true }),
    ], { line: 'Vincent is sharing their screen' });
    const [vincent, you] = screen.getAllByRole('listitem');
    expect(vincent).toHaveAttribute('data-ring', 'amber');
    const open = within(vincent).getByRole('button', { name: "Watch Vincent's screen" });
    fireEvent.click(open);
    expect(onSwitch).toHaveBeenCalledWith('vincent');
    expect(within(you).queryByRole('button')).toBeNull();
    expect(vincent).toHaveTextContent('Sharing screen');
  });

  it('draws the call and the line with nobody to show (you have not joined an empty call)', () => {
    renderEmpty([], { line: 'Join the call to see cameras and share your screen.' });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Join the call to see cameras and share your screen.');
  });

  it("on a phone the card's chrome names the call: smaller faces, no name or line drawn, the line kept for a screen reader", () => {
    renderEmpty([person('brendan'), person('you', { self: true, name: 'You' })], { phone: true });
    const root = document.querySelector('.glass-call-empty') as HTMLElement;
    expect(root).toHaveAttribute('data-layout', 'phone');
    expect(root.style.getPropertyValue('--call-face')).toBe('56px');
    expect(document.querySelector('.glass-call-empty__name')).toBeNull();
    expect(document.querySelector('.glass-call-empty__line')).toBeNull();
    expect(screen.getByRole('status')).toHaveClass('sr-only');
    expect(screen.getByRole('status')).toHaveTextContent('No one is sharing');
  });

  it('shares the faces out evenly between the rows, so nine are five and four, not eight and one', () => {
    expect([1, 2, 5, 6].map((n) => callColumns(n, false))).toEqual([1, 2, 5, 6]);
    // 7 and 8 at 72px fit a row of eight; 9 and 10 are two even rows.
    expect([7, 8, 9, 10].map((n) => callColumns(n, false))).toEqual([7, 8, 5, 5]);
    // 11 at 56px: ten fit a row, so the rows are six and five, not ten and one.
    expect(callColumns(11, false)).toBe(6);
    expect(callColumns(21, false)).toBe(7);
    // The phone's card holds five a row.
    expect([3, 5, 6, 7, 10].map((n) => callColumns(n, true))).toEqual([3, 5, 3, 4, 5]);
    expect(callColumns(0, false)).toBe(1);
    renderEmpty([person('a'), person('b'), person('c')]);
    expect((document.querySelector('.glass-call-empty') as HTMLElement).style.getPropertyValue('--call-columns')).toBe('3');
  });

  it('on a phone the talker\'s waveform stands for the word, which a screen reader keeps', () => {
    renderEmpty([person('brendan', { talking: true })], { phone: true });
    const brendan = screen.getByRole('listitem');
    expect(brendan.querySelector('.glass-call-empty__wave')).not.toBeNull();
    expect(brendan.querySelector('.glass-call-empty__state')).toBeNull();
    expect(brendan.querySelector('.sr-only:last-child')).toHaveTextContent('Talking');
  });

  it('sizes the faces for how many there are, so two read as two and a crowd fits', () => {
    expect(callFaceSize(1, false)).toBe(128);
    expect(callFaceSize(2, false)).toBe(128);
    expect(callFaceSize(3, false)).toBe(112);
    expect(callFaceSize(4, false)).toBe(112);
    expect(callFaceSize(5, false)).toBe(96);
    expect(callFaceSize(6, false)).toBe(96);
    expect(callFaceSize(7, false)).toBe(72);
    expect(callFaceSize(11, false)).toBe(56);
    expect(callFaceSize(30, false)).toBe(56);
    // The phone's card has 120px of room: one row of up to five.
    expect(callFaceSize(2, true)).toBe(56);
    expect(callFaceSize(5, true)).toBe(48);
    expect(callFaceSize(8, true)).toBe(36);
    expect(callFaceSize(30, true)).toBe(28);
    renderEmpty([person('a'), person('b')]);
    expect((document.querySelector('.glass-call-empty') as HTMLElement).style.getPropertyValue('--call-face')).toBe('128px');
  });
});

describe('what the call with no cameras says (callNotice)', () => {
  const model = (over: Partial<StageModel> = {}): StageModel =>
    ({
      cameras: [],
      chips: [person('brendan'), person('you', { self: true, name: 'You' })],
      otherSharers: [],
      relation: 'joined',
      channelName: 'Lounge',
      ...over,
    }) as unknown as StageModel;

  it('says no one is sharing when nobody is', () => {
    expect(callNotice(model())).toBe('No one is sharing');
  });

  it('says who is, instead', () => {
    expect(callNotice(model({ otherSharers: [person('vincent', { sharing: true })] }))).toBe('Vincent is sharing their screen');
    expect(callNotice(model({ otherSharers: [person('vincent'), person('luke')] }))).toBe(
      'Vincent and Luke are sharing their screens',
    );
    expect(callNotice(model({ otherSharers: [person('a'), person('b'), person('c')] }))).toBe('3 people are sharing their screens');
  });

  it('says what you are doing when it is you', () => {
    expect(
      callNotice(model({ chips: [person('you', { self: true, name: 'You', sharing: true })] })),
    ).toBe('You are sharing your screen. Everyone in the call can watch it.');
  });

  it('says how to join, or that it is joining, before you are in', () => {
    expect(callNotice(model({ relation: 'idle' }))).toBe('Join the call to see cameras and share your screen.');
    expect(callNotice(model({ relation: 'joining' }))).toBe('Joining Lounge…');
  });

  it('says nothing when there are cameras to show', () => {
    expect(callNotice(model({ cameras: [person('brendan', { camera: true })] }))).toBeNull();
  });
});
