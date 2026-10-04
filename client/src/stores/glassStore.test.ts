import { beforeEach, describe, expect, it } from 'vitest';
import { selectStageOpen, useGlassStore } from './glassStore';

const LOUNGE = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

beforeEach(() => {
  useGlassStore.getState().reset();
});

describe('glassStore', () => {
  it('starts in the conversation with nothing open', () => {
    const s = useGlassStore.getState();
    expect(s.stage).toEqual({ mode: 'none', serverId: null, guildId: null, channelId: null, streamerId: null });
    expect(selectStageOpen(s)).toBe(false);
    expect(s.browseOpen).toBe(false);
    expect(s.chatHidden).toBe(false);
    expect(s.pillExpanded).toBe(false);
    expect(s.placesOverlayOpen).toBe(false);
    expect(s.sheet).toBeNull();
  });

  it('opens a fresh stage side by side and collapses the pill it grew out of', () => {
    useGlassStore.getState().setPillExpanded(true);
    useGlassStore.getState().openStage(LOUNGE);
    const s = useGlassStore.getState();
    expect(s.stage).toEqual({ mode: 'side', ...LOUNGE });
    expect(s.pillExpanded).toBe(false);
    expect(selectStageOpen(s)).toBe(true);
  });

  it('opens straight into theater when asked', () => {
    useGlassStore.getState().openStage(LOUNGE, 'theater');
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    expect(useGlassStore.getState().chatHidden).toBe(true);
  });

  it('keeps the chosen mode when switching streams inside an open stage', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE);
    store.setStageMode('theater');
    store.toggleChatHidden();
    store.openStage({ ...LOUNGE, streamerId: 'brendan' });
    const s = useGlassStore.getState();
    expect(s.stage).toEqual({ mode: 'theater', ...LOUNGE, streamerId: 'brendan' });
    expect(s.chatHidden).toBe(false);
  });

  it('closing the stage clears browse and hidden chat with it', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE, 'theater');
    store.toggleChatHidden();
    store.toggleBrowse();
    store.closeStage();
    const s = useGlassStore.getState();
    expect(s.stage.mode).toBe('none');
    expect(s.stage.streamerId).toBeNull();
    expect(s.browseOpen).toBe(false);
    expect(s.chatHidden).toBe(false);
  });

  it('ignores stage-only actions while no stage is open', () => {
    const store = useGlassStore.getState();
    store.setStageMode('theater');
    store.toggleBrowse();
    store.setBrowseOpen(true);
    store.toggleChatHidden();
    store.setChatHidden(true);
    const s = useGlassStore.getState();
    expect(s.stage.mode).toBe('none');
    expect(s.browseOpen).toBe(false);
    expect(s.chatHidden).toBe(false);
  });

  it('hides the chat only in theater, and shows it again on the way back to side by side', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE);
    store.toggleChatHidden();
    expect(useGlassStore.getState().chatHidden).toBe(false);

    store.setStageMode('theater');
    expect(useGlassStore.getState().chatHidden).toBe(true);
    store.toggleChatHidden();
    expect(useGlassStore.getState().chatHidden).toBe(false);
    store.setStageMode('theater');
    expect(useGlassStore.getState().chatHidden).toBe(false);
    store.setChatHidden(true);

    store.setStageMode('side');
    expect(useGlassStore.getState().chatHidden).toBe(false);
  });

  it('toggles browse while watching', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE);
    store.toggleBrowse();
    expect(useGlassStore.getState().browseOpen).toBe(true);
    store.setBrowseOpen(false);
    expect(useGlassStore.getState().browseOpen).toBe(false);
  });

  it('opens and closes sheets and the places overlay', () => {
    const store = useGlassStore.getState();
    store.openSheet('search');
    expect(useGlassStore.getState().sheet).toBe('search');
    store.closeSheet();
    expect(useGlassStore.getState().sheet).toBeNull();
    store.setPlacesOverlayOpen(true);
    expect(useGlassStore.getState().placesOverlayOpen).toBe(true);
  });

  it('reset returns to the initial state', () => {
    const store = useGlassStore.getState();
    store.openStage(LOUNGE, 'theater');
    store.openSheet('people');
    store.setPlacesOverlayOpen(true);
    store.reset();
    const s = useGlassStore.getState();
    expect(s.stage.mode).toBe('none');
    expect(s.sheet).toBeNull();
    expect(s.placesOverlayOpen).toBe(false);
  });
});
