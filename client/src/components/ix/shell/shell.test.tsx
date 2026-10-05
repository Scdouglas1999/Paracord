import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { PEOPLE_PLACE, placeDirection, placeKey, placeOfPath, samePlace, serverPlace } from './place';
import { SidebarPanes } from './SidebarPanes';
import { TintLayers } from './TintLayers';
import { Toolbar } from './Toolbar';
import { IxShellProvider, type IxShellValue } from './IxShellContext';
import { useToolbar, useToolbarStore, type ToolbarPage } from './toolbarStore';

vi.mock('../sidebar', () => ({
  SidebarSlot: ({ place, leaving }: { place: { kind: string; guildId?: string }; leaving?: boolean }) => (
    <div data-testid="slot" data-place={place.kind === 'people' ? 'people' : place.guildId} data-leaving={String(Boolean(leaving))} />
  ),
}));
const toggleSheet = vi.hoisted(() => vi.fn());
vi.mock('../../glass/sheets', () => ({ toggleSheet }));
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: '42', username: 'scott', display_name: 'Scott', avatar_hash: null }),
}));

let waapi: WaapiStub;
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  waapi = installWaapiStub();
  resetMotionSwitchForTests();
  configureMotion('full');
  toggleSheet.mockReset();
  useToolbarStore.setState({ page: null, owner: null });
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
});

describe('places', () => {
  it('come from the route; routes that belong to none give null', () => {
    expect(placeOfPath('/app/guilds/123/channels/9')).toEqual(serverPlace('123'));
    expect(placeOfPath('/app/guilds/123')).toEqual(serverPlace('123'));
    expect(placeOfPath('/app/guilds/123/settings')).toEqual(serverPlace('123'));
    // Home is retired: `/app` only redirects, so it belongs to no place (the sidebar keeps the last).
    expect(placeOfPath('/app')).toBeNull();
    expect(placeOfPath('/app/dms')).toEqual(PEOPLE_PLACE);
    expect(placeOfPath('/app/dms/77')).toEqual(PEOPLE_PLACE);
    expect(placeOfPath('/app/friends')).toEqual(PEOPLE_PLACE);
    expect(placeOfPath('/app/inbox')).toEqual(PEOPLE_PLACE);
    expect(placeOfPath('/app/admin')).toBeNull();
    expect(placeOfPath('/app/discovery')).toBeNull();
  });

  it('are keyed `people` or by the server id (the dock item\'s data-place)', () => {
    expect(placeKey(PEOPLE_PLACE)).toBe('people');
    expect(placeKey(serverPlace('123'))).toBe('123');
    expect(samePlace(serverPlace('1'), serverPlace('1'))).toBe(true);
    expect(samePlace(serverPlace('1'), PEOPLE_PLACE)).toBe(false);
  });

  it('slide in the direction of the dock order; unknown order crossfades', () => {
    const order = ['people', 'fuel', 'gn', 'base'];
    expect(placeDirection(order, serverPlace('fuel'), serverPlace('gn'))).toBe(1);
    expect(placeDirection(order, serverPlace('base'), PEOPLE_PLACE)).toBe(-1);
    expect(placeDirection(order, serverPlace('gn'), serverPlace('gn'))).toBe(0);
    expect(placeDirection(order, serverPlace('new'), serverPlace('gn'))).toBe(0);
    expect(placeDirection(order, null, serverPlace('gn'))).toBe(0);
  });
});

describe('SidebarPanes (§5.1)', () => {
  const order = ['people', 'fuel', 'gn', 'base'];
  const panes = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.ix-pane')];

  it('mounts the new pane beside the old one, slides them by dock order, then removes the old one', async () => {
    const { container, rerender } = render(<SidebarPanes place={serverPlace('fuel')} order={order} />);
    expect(panes(container).map((pane) => pane.dataset.place)).toEqual(['fuel']);
    expect(waapi.played).toHaveLength(0);

    rerender(<SidebarPanes place={serverPlace('gn')} order={order} />);
    const [old, next] = panes(container);
    expect(old.dataset.place).toBe('fuel');
    expect(old).toHaveAttribute('inert');
    expect(old).toHaveAttribute('aria-hidden', 'true');
    expect(old.querySelector('[data-testid="slot"]')).toHaveAttribute('data-leaving', 'true');
    expect(next.dataset.place).toBe('gn');
    expect(next).not.toHaveAttribute('inert');

    const out = waapi.played.find((record) => record.target === old);
    const into = waapi.played.find((record) => record.target === next);
    expect(out?.keyframes[1]).toMatchObject({ transform: 'translateX(-40%)', opacity: 0 });
    expect(into?.keyframes[0]).toMatchObject({ transform: 'translateX(60%)', opacity: 0 });

    act(() => {
      out?.animation.finish();
      into?.animation.finish();
    });
    await flush();
    expect(panes(container).map((pane) => pane.dataset.place)).toEqual(['gn']);
    expect(panes(container)[0]).toBe(next);
  });

  it('slides the other way for a place left of the current one', () => {
    const { container, rerender } = render(<SidebarPanes place={serverPlace('base')} order={order} />);
    rerender(<SidebarPanes place={PEOPLE_PLACE} order={order} />);
    const [old] = panes(container);
    const out = waapi.played.find((record) => record.target === old);
    expect(out?.keyframes[1]).toMatchObject({ transform: 'translateX(40%)' });
  });

  it('a newer switch mid-slide drops the leaving pane at once and slides from the current one (no queue)', async () => {
    const { container, rerender } = render(<SidebarPanes place={serverPlace('fuel')} order={order} />);
    rerender(<SidebarPanes place={serverPlace('gn')} order={order} />);
    const first = waapi.played.slice();
    rerender(<SidebarPanes place={serverPlace('base')} order={order} />);
    expect(panes(container).map((pane) => pane.dataset.place)).toEqual(['gn', 'base']);
    // The first slide was put to rest, not left running.
    expect(first.every((record) => record.canceled || record.finished)).toBe(true);
    const live = waapi.live();
    expect(live).toHaveLength(2);
    act(() => live.forEach((record) => record.animation.finish()));
    await flush();
    expect(panes(container).map((pane) => pane.dataset.place)).toEqual(['base']);
    expect(waapi.live()).toHaveLength(0);
  });

  it('coming straight back to the place that is leaving brings the same pane back, at rest', async () => {
    const { container, rerender } = render(<SidebarPanes place={serverPlace('fuel')} order={order} />);
    const fuel = panes(container)[0];
    rerender(<SidebarPanes place={serverPlace('gn')} order={order} />);
    rerender(<SidebarPanes place={serverPlace('fuel')} order={order} />);
    const back = panes(container).find((pane) => pane.dataset.place === 'fuel');
    expect(back).toBe(fuel);
    expect(back).not.toHaveAttribute('inert');
    // Its old slide-out (which fills forwards) was canceled, not finished, so it cannot hold the pane hidden.
    const outs = waapi.played.filter((record) => record.target === fuel && record.options.fill === 'forwards');
    expect(outs.every((record) => record.canceled)).toBe(true);
    act(() => waapi.live().forEach((record) => record.animation.finish()));
    await flush();
    expect(panes(container).map((pane) => pane.dataset.place)).toEqual(['fuel']);
  });

  it('with no animation engine (or nothing to play) the switch is immediate', () => {
    waapi.restore();
    const { container, rerender } = render(<SidebarPanes place={serverPlace('fuel')} order={order} />);
    rerender(<SidebarPanes place={serverPlace('gn')} order={order} />);
    expect(panes(container).map((pane) => pane.dataset.place)).toEqual(['gn']);
  });
});

describe('TintLayers (§2.2, §5.1)', () => {
  const layers = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-ix-tint]')];

  it('is one layer at rest, with the hue as a plain number', () => {
    const { container } = render(<TintLayers hue={350} kind="side" />);
    const [layer] = layers(container);
    expect(layers(container)).toHaveLength(1);
    expect(layer).toHaveClass('ix-tint', 'ix-hue-side');
    expect(layer.style.getPropertyValue('--ix-hue')).toBe('350');
    expect(layer).toHaveAttribute('data-native-underlay-clear');
    expect(waapi.played).toHaveLength(0);
  });

  it('fades a new layer in over the old one and removes the old one when the fade settles', async () => {
    const { container, rerender } = render(<TintLayers hue={350} kind="main" />);
    rerender(<TintLayers hue={190} kind="main" />);
    const [old, next] = layers(container);
    expect(old.dataset.hue).toBe('350');
    expect(next.dataset.hue).toBe('190');
    expect(next).toHaveClass('ix-hue-main');
    expect(waapi.played).toHaveLength(1);
    expect(waapi.played[0].target).toBe(next);
    expect(waapi.played[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(waapi.played[0].options.duration).toBe(410);

    act(() => waapi.played[0].animation.finish());
    await flush();
    expect(layers(container).map((layer) => layer.dataset.hue)).toEqual(['190']);
    expect(waapi.live()).toHaveLength(0);
  });

  it('a second change mid-fade commits the first: never more than two layers', async () => {
    const { container, rerender } = render(<TintLayers hue={350} kind="side" />);
    rerender(<TintLayers hue={190} kind="side" />);
    rerender(<TintLayers hue={210} kind="side" />);
    expect(layers(container).map((layer) => layer.dataset.hue)).toEqual(['190', '210']);
    expect(waapi.played[0].finished).toBe(true);
    act(() => waapi.live().forEach((record) => record.animation.finish()));
    await flush();
    expect(layers(container).map((layer) => layer.dataset.hue)).toEqual(['210']);
  });
});

describe('Toolbar (§4.9)', () => {
  const shell = (patch: Partial<IxShellValue> = {}): IxShellValue => ({
    layout: 'wide',
    place: serverPlace('g1'),
    guildId: 'g1',
    channelId: 'c1',
    ...patch,
  });

  function Page(props: ToolbarPage) {
    useToolbar(props);
    return null;
  }

  function renderToolbar(value: IxShellValue, page?: ToolbarPage) {
    return render(
      <MemoryRouter>
        <IxShellProvider value={value}>
          <Toolbar />
          {page && <Page {...page} />}
        </IxShellProvider>
      </MemoryRouter>,
    );
  }

  it('has search, members and your avatar in a channel; search and members open their sheets', () => {
    renderToolbar(shell());
    act(() => screen.getByRole('button', { name: 'Search messages' }).click());
    expect(toggleSheet).toHaveBeenLastCalledWith('search');
    act(() => screen.getByRole('button', { name: 'Members' }).click());
    expect(toggleSheet).toHaveBeenLastCalledWith('people');
    const me = screen.getByRole('button', { name: 'Your account' });
    expect(me).toHaveAttribute('data-ix-account-anchor');
    act(() => me.click());
    expect(toggleSheet).toHaveBeenLastCalledWith('account');
  });

  it('names the people button for a DM, and has neither tool where there is no conversation', () => {
    const { unmount } = renderToolbar(shell({ guildId: null, channelId: 'd1', place: PEOPLE_PLACE }));
    expect(screen.getByRole('button', { name: 'People in this message' })).toBeInTheDocument();
    unmount();
    renderToolbar(shell({ guildId: null, channelId: null, place: PEOPLE_PLACE }));
    expect(screen.queryByRole('button', { name: 'Search messages' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Members|People in this message/ })).not.toBeInTheDocument();
  });

  it('shows the page\'s folded title once folded, with its fill; the title opens the page\'s menu', () => {
    const onTitleClick = vi.fn();
    const { rerender } = renderToolbar(shell(), { title: 'general', onTitleClick, titleHasPopup: 'menu', folded: false });
    const bar = screen.getByTestId('ix-toolbar');
    expect(bar).toHaveAttribute('data-folded', 'false');
    const hidden = bar.querySelector('.ix-toolbar__title') as HTMLButtonElement;
    expect(hidden).toHaveAttribute('aria-hidden', 'true');
    expect(hidden).toHaveAttribute('tabindex', '-1');

    rerender(
      <MemoryRouter>
        <IxShellProvider value={shell()}>
          <Toolbar />
          <Page title="general" onTitleClick={onTitleClick} titleHasPopup="menu" folded />
        </IxShellProvider>
      </MemoryRouter>,
    );
    expect(bar).toHaveAttribute('data-folded', 'true');
    const title = screen.getByRole('button', { name: 'general' });
    expect(title).toHaveAttribute('aria-haspopup', 'menu');
    act(() => title.click());
    expect(onTitleClick).toHaveBeenCalled();
  });

  it('a pushed page gets the back chevron and a DM its call button; leaving the page clears them', () => {
    const onBack = vi.fn();
    const { rerender } = renderToolbar(shell(), {
      title: 'Thread',
      onBack,
      backLabel: 'Back to general',
      call: <button type="button">Call Jeremy</button>,
    });
    act(() => screen.getByRole('button', { name: 'Back to general' }).click());
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Call Jeremy' })).toBeInTheDocument();
    expect(useToolbarStore.getState().page).not.toBeNull();

    rerender(
      <MemoryRouter>
        <IxShellProvider value={shell()}>
          <Toolbar />
        </IxShellProvider>
      </MemoryRouter>,
    );
    expect(useToolbarStore.getState().page).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to general' })).not.toBeInTheDocument();
  });

  it('a page leaving after the next one registered does not clear the newcomer', () => {
    function Two({ show }: { show: 'a' | 'both' | 'b' }) {
      return (
        <>
          {show !== 'b' && <Page title="A" />}
          {show !== 'a' && <Page title="B" />}
        </>
      );
    }
    const { rerender } = render(<Two show="a" />);
    rerender(<Two show="both" />);
    expect(useToolbarStore.getState().page?.title).toBe('B');
    rerender(<Two show="b" />);
    expect(useToolbarStore.getState().page?.title).toBe('B');
  });
});
