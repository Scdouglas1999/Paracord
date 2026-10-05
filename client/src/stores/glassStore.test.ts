import { beforeEach, describe, expect, it } from 'vitest';
import { selectStageOpen, useGlassStore } from './glassStore';

const LOUNGE = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

beforeEach(() => {
  useGlassStore.getState().reset();
});

describe('glassStore', () => {
  it('starts in the conversation with nothing open', () => {
    const s = useGlassStore.getState();
    expect(s.stage).toEqual({ mode: 'none', chat: false, serverId: null, guildId: null, channelId: null, streamerId: null });
    expect(selectStageOpen(s)).toBe(false);
    expect(s.sheet).toBeNull();
  });

  it('opens a fresh call view in main', () => {
    useGlassStore.getState().openStage(LOUNGE);
    const s = useGlassStore.getState();
    expect(s.stage).toEqual({ mode: 'main', chat: false, ...LOUNGE });
    expect(selectStageOpen(s)).toBe(true);
  });

  it('opens straight into theater when asked', () => {
    useGlassStore.getState().openStage(LOUNGE, 'theater');
    expect(useGlassStore.getState().stage.mode).toBe('theater');
  });

  it('keeps the chosen mode when switching streams inside an open call view', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE);
    store.setStageMode('theater');
    store.openStage({ ...LOUNGE, streamerId: 'brendan' });
    expect(useGlassStore.getState().stage).toEqual({ mode: 'theater', chat: false, ...LOUNGE, streamerId: 'brendan' });
  });

  it('moves between main and theater', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE);
    store.setStageMode('theater');
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    store.setStageMode('main');
    expect(useGlassStore.getState().stage.mode).toBe('main');
  });

  it('closing the call view clears the target with it', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE, 'theater');
    store.closeStage();
    const s = useGlassStore.getState();
    expect(s.stage.mode).toBe('none');
    expect(s.stage.streamerId).toBeNull();
  });

  it('H turns the call view\'s chat column on and off; a fresh view starts without it, a stream switch keeps it', () => {
    const store = useGlassStore.getState();
    store.toggleChat();
    expect(useGlassStore.getState().stage.chat).toBe(false);
    store.openStage(LOUNGE);
    store.toggleChat();
    expect(useGlassStore.getState().stage.chat).toBe(true);
    store.openStage({ ...LOUNGE, streamerId: 'brendan' });
    expect(useGlassStore.getState().stage.chat).toBe(true);
    store.toggleChat();
    expect(useGlassStore.getState().stage.chat).toBe(false);
    store.toggleChat();
    store.closeStage();
    expect(useGlassStore.getState().stage.chat).toBe(false);
    store.openStage(LOUNGE);
    expect(useGlassStore.getState().stage.chat).toBe(false);
  });

  it('ignores call-view-only actions while none is open', () => {
    const store = useGlassStore.getState();
    store.setStageMode('theater');
    store.toggleChat();
    expect(useGlassStore.getState().stage).toEqual({ mode: 'none', chat: false, serverId: null, guildId: null, channelId: null, streamerId: null });
  });

  it('opens and closes sheets', () => {
    const store = useGlassStore.getState();
    store.openSheet('search');
    expect(useGlassStore.getState().sheet).toBe('search');
    store.closeSheet();
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('reset returns to the initial state', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE, 'theater');
    store.openSheet('people');
    store.reset();
    const s = useGlassStore.getState();
    expect(s.stage.mode).toBe('none');
    expect(s.sheet).toBeNull();
  });
});
