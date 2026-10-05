import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  configureMotion,
  emitMotion,
  resetMotionBusForTests,
  resetMotionSwitchForTests,
  type MotionEvents,
  type SendOrigin,
} from '../../lib/motion';
import { installWaapiStub, type RecordedAnimation, type WaapiStub } from '../../lib/motion/waapiStub';
import { MessageType, type Message } from '../../types';
import { sendRowKey, useSendFlight } from './useSendFlight';

/**
 * The timeline's half of the send flight, on a small stand-in for the list: rows
 * keyed by index (the virtualizer's default, which is why the delivered row can
 * take the stand-in's node), a scroller, and the "Delivered" line under the last.
 */

const me = { id: '42', username: 'sean', discriminator: '1' };
const them = { id: '51', username: 'vincent', discriminator: '1' };
const ORIGIN: SendOrigin = { left: 400, top: 800, width: 700, height: 36, inset: 10, color: 'rgb(243, 245, 245)' };

function message(id: string, content: string, author: Message['author'] = them): Message {
  return {
    id,
    channel_id: 'c1',
    author,
    content,
    created_at: '2026-10-01T21:12:00-05:00',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: MessageType.Default,
    attachments: [],
    reactions: [],
  };
}

const history = [message('1', 'who is on tonight'), message('2', 'me', them)];

interface Props {
  messages: Message[];
  grounded: (say: MotionEvents['say:sent']) => void;
  measured: (row: HTMLElement) => void;
}

function List({ messages, grounded, measured }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const drawn = useSendFlight({ channelId: 'c1', me, messages, scroller, onGrounded: grounded, measureRow: measured });
  const last = drawn[drawn.length - 1];
  return (
    <div ref={scroller} data-testid="scroller">
      <div className="glass-timeline__content">
        {drawn.map((entry, index) => (
          <div key={index}>
            <div id={`msg-${entry.id}`} className="glass-msg" data-own={entry.author.id === me.id || undefined}>
              <div className="glass-bubble">
                <div className="glass-bubble__text">{entry.content}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {last?.author.id === me.id && (
        <div className="glass-tl-receipt">
          <span data-motion-receipt>Delivered</span>
        </div>
      )}
    </div>
  );
}

let waapi: WaapiStub;
let grounded: Mock<(say: MotionEvents['say:sent']) => void>;
let measured: Mock<(row: HTMLElement) => void>;

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  }));
}

/**
 * The Index timeline's way: rows keyed by identity (`sendRowKey`), with a typing
 * row after the messages. The stand-in and its delivered message share a key.
 */
function KeyedList({ messages, grounded, measured, typing }: Props & { typing?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useRef(new Map<string, string>());
  const drawn = useSendFlight({ channelId: 'c1', me, messages, scroller, onGrounded: grounded, measureRow: measured, rowKeys: keys.current });
  return (
    <div ref={scroller} data-testid="scroller">
      <div className="glass-timeline__content">
        {drawn.map((entry) => (
          <div key={sendRowKey(entry, keys.current)}>
            <div id={`msg-${entry.id}`} className="glass-msg" data-own={entry.author.id === me.id || undefined}>
              <div className="glass-bubble">
                <div className="glass-bubble__text">{entry.content}</div>
              </div>
            </div>
          </div>
        ))}
        {typing && (
          <div key="typing">
            <div className="glass-tl-typing-row" data-testid="typing" />
          </div>
        )}
      </div>
    </div>
  );
}

function setup(messages: Message[] = history) {
  const view = render(<List messages={messages} grounded={grounded} measured={measured} />);
  const again = (next: Message[]) => view.rerender(<List messages={next} grounded={grounded} measured={measured} />);
  return { ...view, again };
}

/** The key goes down: the composer says so on the bus, inside React's batch. */
async function say(text: string, nonce = 'n1', options: Partial<MotionEvents['say:sent']> = {}) {
  await act(async () => {
    emitMotion('say:sent', { channelId: 'c1', nonce, text, origin: ORIGIN, ...options });
  });
}

const row = (id: string) => document.getElementById(`msg-${id}`);
const flight = (): RecordedAnimation[] =>
  waapi.played.filter((record) => record.animation.id === 'data-motion-recipe:send-flight');
const lifter = () => flight().find((record) => record.keyframes.length === 3)!;

async function land() {
  await act(async () => {
    lifter().animation.finish();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  resetMotionSwitchForTests();
  resetMotionBusForTests();
  stubMatchMedia(false);
  configureMotion('full');
  waapi = installWaapiStub();
  grounded = vi.fn<(say: MotionEvents['say:sent']) => void>();
  measured = vi.fn<(row: HTMLElement) => void>();
  // jsdom lays nothing out: give every element a box, so there is somewhere to land.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 100, top: 200, width: 260, height: 40, right: 360, bottom: 240, x: 100, y: 200, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  waapi.restore();
  resetMotionBusForTests();
  resetMotionSwitchForTests();
});

describe('taking off', () => {
  it('appends a stand-in row, keeps it out of sight, and flies a bubble to it', async () => {
    setup();
    await say('count me in');
    const stand = row('sending:n1');
    expect(stand).not.toBeNull();
    expect(stand?.textContent).toBe('count me in');
    expect(stand?.getAttribute('data-flight')).toBe('air');
    expect(stand?.getAttribute('aria-hidden')).toBe('true');
    // The virtual list laid it out at its measured size before the flight read the layout.
    expect(measured).toHaveBeenCalledWith(stand);
    expect(flight()).toHaveLength(5);
    expect(document.querySelectorAll('.glass-flight')).toHaveLength(1);
    expect(grounded).not.toHaveBeenCalled();
    // Its "Delivered" line has its room reserved but is not shown: nothing has been delivered.
    expect(document.querySelector('.glass-tl-receipt')?.hasAttribute('data-flight-hold')).toBe(true);
  });

  it('makes room for it: the rows already there glide up from where they were, on the flight\'s curve', async () => {
    // Once the stand-in exists every other row sits 60px higher (the list is bottom-anchored).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const standing = document.getElementById('msg-sending:n1') !== null;
      const top = 200 - (standing && !this.id.startsWith('msg-sending:') && this.classList.contains('glass-msg') ? 60 : 0);
      return { left: 100, top, width: 260, height: 40, right: 360, bottom: top + 40, x: 100, y: top, toJSON: () => ({}) } as DOMRect;
    });
    setup();
    await say('count me in');
    const glides = waapi.played.filter((record) => record.animation.id === 'data-motion-recipe:send-room');
    // Both rows of history, from 60px below where they now are, to where they are.
    expect(glides).toHaveLength(2);
    for (const glide of glides) {
      expect(glide.keyframes[0].transform).toBe('translate3d(0px, 60px, 0)');
      expect(Number(glide.options.duration)).toBe(255);
      expect(glide.options.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    }
  });

  it('declines under reduced motion, and says so, so the arrival settles in as it always did', async () => {
    stubMatchMedia(true);
    configureMotion('system');
    setup();
    await say('count me in');
    expect(row('sending:n1')).toBeNull();
    expect(flight()).toHaveLength(0);
    expect(grounded).toHaveBeenCalledTimes(1);
    expect(grounded.mock.calls[0][0]).toMatchObject({ nonce: 'n1', text: 'count me in' });
  });

  it('declines when the composer has nowhere to fly from', async () => {
    setup();
    await say('count me in', 'n1', { origin: null });
    expect(row('sending:n1')).toBeNull();
    expect(grounded).toHaveBeenCalledTimes(1);
  });

  it('flies into an empty conversation too: the first thing said lands in an empty timeline', async () => {
    setup([]);
    await say('first');
    expect(row('sending:n1')).not.toBeNull();
    expect(flight()).toHaveLength(5);
    expect(grounded).not.toHaveBeenCalled();
  });

  it('declines when the reader is not at the newest messages', async () => {
    const view = setup();
    const scroller = view.getByTestId('scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    await say('count me in');
    expect(row('sending:n1')).toBeNull();
    expect(grounded).toHaveBeenCalledTimes(1);
  });

  it('declines for another conversation\'s send', async () => {
    setup();
    await act(async () => {
      emitMotion('say:sent', { channelId: 'elsewhere', nonce: 'n9', text: 'hi', origin: ORIGIN });
    });
    expect(row('sending:n9')).toBeNull();
    expect(grounded).not.toHaveBeenCalled();
  });

  it('lands on nothing when the row has no bubble (a card is not a bubble), and says so', async () => {
    setup();
    // Make the stand-in render with no bubble, as an event share would.
    vi.spyOn(Element.prototype, 'querySelector').mockImplementation(function (this: Element, selector: string) {
      if (selector === '.glass-bubble' && this.id.startsWith('msg-sending:')) return null;
      return Document.prototype.querySelector.call(this.ownerDocument, selector);
    });
    await say('<event:1>');
    expect(row('sending:n1')).toBeNull();
    expect(grounded).toHaveBeenCalledTimes(1);
  });
});

describe('the hand-off', () => {
  it('replaces the stand-in with the delivered message on the same node, still hidden until the bubble lands', async () => {
    const view = setup();
    await say('count me in');
    const stand = row('sending:n1');
    const delivered = message('900', 'count me in', me);
    await act(async () => view.again([...history, delivered]));
    // No double: the stand-in is gone and the delivered row is the same element.
    expect(row('sending:n1')).toBeNull();
    expect(row('900')).toBe(stand);
    expect(document.querySelectorAll('.glass-msg[data-own]')).toHaveLength(1);
    // The bubble is still in the air, so the row stays out of sight.
    expect(row('900')?.getAttribute('data-flight')).toBe('air');
    await land();
    // Revealed in the same task the ghost went: one row, visible, no hold, no ghost.
    expect(row('900')?.hasAttribute('data-flight')).toBe(false);
    expect(row('900')?.hasAttribute('aria-hidden')).toBe(false);
    expect(document.querySelector('.glass-flight')).toBeNull();
    // Delivered: the line is no longer held, and it fades in after the bubble.
    expect(document.querySelector('.glass-tl-receipt')?.hasAttribute('data-flight-hold')).toBe(false);
    expect(waapi.played.some((record) => record.keyframes[0]?.opacity === 0 && record.keyframes[1]?.opacity === 1
      && record.target === document.querySelector('[data-motion-receipt]'))).toBe(true);
    // And no second animation on the real row: it never settles in.
    expect(waapi.played.filter((record) => record.target === row('900'))).toHaveLength(0);
    expect(grounded).not.toHaveBeenCalled();
  });

  it('holds a landed bubble in place, inert, while the server has not answered, then lets it be a message', async () => {
    const view = setup();
    await say('count me in');
    await land();
    // Landed, nothing delivered yet: visible where the delivered row will be, but not interactive.
    expect(row('sending:n1')?.getAttribute('data-flight')).toBe('held');
    expect(document.querySelector('.glass-flight')).toBeNull();
    expect(document.querySelector('.glass-tl-receipt')?.hasAttribute('data-flight-hold')).toBe(true);
    const stand = row('sending:n1');
    await act(async () => view.again([...history, message('900', 'count me in', me)]));
    expect(row('900')).toBe(stand);
    expect(row('900')?.hasAttribute('data-flight')).toBe(false);
    expect(row('900')?.hasAttribute('aria-hidden')).toBe(false);
    expect(document.querySelector('.glass-tl-receipt')?.hasAttribute('data-flight-hold')).toBe(false);
    expect(waapi.played.filter((record) => record.target === row('900'))).toHaveLength(0);
  });

  it('gives each of two quick sends its own message', async () => {
    const view = setup();
    await say('first', 'n1');
    await say('second', 'n2');
    expect(row('sending:n1')).not.toBeNull();
    expect(row('sending:n2')).not.toBeNull();
    // They land in the order they were sent, whatever order the server answers in.
    await act(async () => view.again([...history, message('901', 'second', me), message('900', 'first', me)]));
    expect(row('sending:n1')).toBeNull();
    expect(row('sending:n2')).toBeNull();
    expect(document.querySelectorAll('.glass-msg[data-own]')).toHaveLength(2);
    expect(document.querySelectorAll('.glass-msg[data-own][data-flight]')).toHaveLength(2);
  });
});

describe('rows keyed by identity (the Index timeline)', () => {
  it('keeps one node for the stand-in and its delivered message, and the typing row its own node', async () => {
    const view = render(<KeyedList messages={history} grounded={grounded} measured={measured} typing />);
    const typing = document.querySelector('[data-testid="typing"]');
    await say('count me in');
    // The stand-in is drawn before the typing row; the typing row is the same element.
    expect(document.querySelector('[data-testid="typing"]')).toBe(typing);
    const stand = row('sending:n1');
    expect(stand).not.toBeNull();
    const delivered = message('900', 'count me in', me);
    await act(async () => view.rerender(<KeyedList messages={[...history, delivered]} grounded={grounded} measured={measured} typing />));
    expect(row('900')).toBe(stand);
    expect(document.querySelector('[data-testid="typing"]')).toBe(typing);
    // The next send does not remount the delivered row: its key outlives the flight.
    await land();
    await say('again', 'n2');
    expect(row('900')).toBe(stand);
    expect(row('sending:n2')).not.toBeNull();
    expect(document.querySelector('[data-testid="typing"]')).toBe(typing);
  });

  it('keys a stand-in by its own id and a delivered message by the stand-in it replaced', () => {
    const keys = new Map([['900', 'sending:n1']]);
    expect(sendRowKey({ id: 'sending:n2' }, keys)).toBe('sending:n2');
    expect(sendRowKey({ id: '900' }, keys)).toBe('sending:n1');
    expect(sendRowKey({ id: '901' }, keys)).toBe('901');
    expect(sendRowKey({ id: '901' }, null)).toBe('901');
  });
});

describe('a send that does not arrive', () => {
  it('lets the bubble go when the composer says the send failed: it freezes and fades, the stand-in goes', async () => {
    setup();
    await say('count me in');
    expect(row('sending:n1')).not.toBeNull();
    await act(async () => {
      emitMotion('say:settled', { channelId: 'c1', nonce: 'n1', ok: false });
    });
    expect(row('sending:n1')).toBeNull();
    // Nothing is left hidden and nothing is revealed that does not exist.
    expect(document.querySelectorAll('[data-flight]')).toHaveLength(0);
    expect(flight().filter((record) => record.paused)).toHaveLength(5);
    const ghost = document.querySelector('.glass-flight');
    expect(ghost).not.toBeNull(); // fading, not yet gone
    const fade = waapi.played.find((record) => record.target === ghost && record.keyframes[1]?.opacity === 0);
    await act(async () => {
      fade?.animation.finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('.glass-flight')).toBeNull();
    expect(document.querySelector('.glass-tl-receipt')).toBeNull();
    expect(grounded).not.toHaveBeenCalled();
  });

  it('ignores an accepted send: the outbox owns delivery from there, and the bubble waits for it', async () => {
    setup();
    await say('count me in');
    await act(async () => {
      emitMotion('say:settled', { channelId: 'c1', nonce: 'n1', ok: true });
    });
    expect(row('sending:n1')).not.toBeNull();
    expect(flight().some((record) => record.paused)).toBe(false);
  });

  it('lets go of a bubble nothing ever answers for, and the message still settles in when it comes', async () => {
    vi.useFakeTimers();
    try {
      setup();
      await say('count me in');
      expect(row('sending:n1')).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(6_100);
      });
      expect(row('sending:n1')).toBeNull();
      expect(grounded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes everything when the conversation is left mid-flight', async () => {
    const view = setup();
    await say('count me in');
    view.unmount();
    expect(document.querySelector('.glass-flight')).toBeNull();
  });
});
