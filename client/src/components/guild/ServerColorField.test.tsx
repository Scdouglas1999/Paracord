import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PALETTE_HUES, paletteHue } from '../../lib/identityHue';
import { LOCAL_SERVER_ID } from '../../lib/serverScope';
import { useAuthStore } from '../../stores/authStore';
import { scopeGuild, useGuildStore } from '../../stores/guildStore';
import type { Guild } from '../../types';
import { ServerColorField } from './ServerColorField';
import { ICON_SAMPLE } from './iconPixels';

const SCOPE = { serverId: LOCAL_SERVER_ID, userId: 'viewer' };

const reader = vi.hoisted(() => ({ pixels: null as Uint8ClampedArray | null }));
vi.mock('./iconPixels', async (original) => {
  const actual = await original<typeof import('./iconPixels')>();
  return { ...actual, readIconPixels: vi.fn(async () => reader.pixels) };
});

const updateGuild = vi.fn();

function baseGuild(over: Partial<Guild> = {}): Guild {
  return {
    id: '310000000000000000',
    name: 'Fuel',
    owner_id: 'viewer',
    member_count: 1,
    created_at: '2026-01-01T00:00:00Z',
    hue: null,
    ...over,
  } as Guild;
}

function seed(guild: Guild) {
  useAuthStore.setState({ user: { id: 'viewer', username: 'viewer' } as never, token: 'token' });
  useGuildStore.setState({ guilds: [scopeGuild(guild, SCOPE)], updateGuild } as never);
}

/** A 32x32 icon: a teal disc on nothing (hsl 176). */
function tealIcon(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(ICON_SAMPLE * ICON_SAMPLE * 4);
  for (let i = 0; i < ICON_SAMPLE * ICON_SAMPLE; i += 1) {
    const x = i % ICON_SAMPLE;
    const y = Math.floor(i / ICON_SAMPLE);
    if (Math.hypot(x - 15.5, y - 15.5) <= 13) data.set([31, 173, 161, 255], i * 4);
  }
  return data;
}

beforeEach(() => {
  updateGuild.mockReset();
  updateGuild.mockImplementation(async (id: string, patch: Partial<Guild>) => {
    useGuildStore.getState().updateGuildData(id, patch, SCOPE);
  });
  reader.pixels = null;
});
afterEach(cleanup);

describe('ServerColorField', () => {
  it('offers the eleven palette swatches, none pressed until one is picked (automatic)', () => {
    const guild = baseGuild();
    seed(guild);
    render(<ServerColorField guild={guild} iconSrc={null} />);
    const group = screen.getByRole('group', { name: 'Server color swatches' });
    const swatches = within(group).getAllByRole('button');
    expect(swatches).toHaveLength(11);
    expect(swatches.every((swatch) => swatch.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(screen.getByRole('button', { name: 'Automatic' })).toHaveAttribute('aria-pressed', 'true');
    // The automatic color is the id's: the line says which swatch that is.
    expect(screen.getByTestId('server-color-now')).toHaveTextContent(/^Automatic\./);
    expect(PALETTE_HUES).toContain(paletteHue(guild.id));
  });

  it('saves the picked hue through the guild store, scoped to the account', async () => {
    const user = userEvent.setup();
    const guild = baseGuild();
    seed(guild);
    render(<ServerColorField guild={guild} iconSrc={null} />);
    await user.click(screen.getByRole('button', { name: 'Teal' }));
    expect(updateGuild).toHaveBeenCalledWith(guild.id, { hue: 176 }, SCOPE);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Teal' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: 'Automatic' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Server color set to Teal.');
  });

  it('clears the pick with Automatic (null, not a number)', async () => {
    const user = userEvent.setup();
    const guild = baseGuild({ hue: 22 });
    seed(guild);
    render(<ServerColorField guild={guild} iconSrc={null} />);
    expect(screen.getByRole('button', { name: 'Orange' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Automatic' }));
    expect(updateGuild).toHaveBeenCalledWith(guild.id, { hue: null }, SCOPE);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Automatic' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('Match icon computes the icon\'s hue on this client and saves that number', async () => {
    const user = userEvent.setup();
    const guild = baseGuild();
    seed(guild);
    reader.pixels = tealIcon();
    render(<ServerColorField guild={guild} iconSrc="data:image/png;base64,AAAA" />);
    await user.click(screen.getByRole('button', { name: 'Match icon' }));
    await waitFor(() => expect(updateGuild).toHaveBeenCalledTimes(1));
    const [id, patch, scope] = updateGuild.mock.calls[0];
    expect(id).toBe(guild.id);
    expect(scope).toEqual(SCOPE);
    expect(patch.hue).toBeGreaterThanOrEqual(172);
    expect(patch.hue).toBeLessThanOrEqual(180);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Server color matched to the icon.'));
  });

  it('shows a matched hue that is not on the palette as a selected custom swatch', () => {
    const guild = baseGuild({ hue: 123 });
    seed(guild);
    render(<ServerColorField guild={guild} iconSrc={null} />);
    expect(screen.getByRole('img', { name: 'Matched to the icon, selected' })).toBeInTheDocument();
    expect(screen.getByTestId('server-color-now')).toHaveTextContent('Matched to the icon.');
    for (const swatch of within(screen.getByRole('group', { name: 'Server color swatches' })).getAllByRole('button')) {
      expect(swatch).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('says so, and saves nothing, when the icon has no color or cannot be read', async () => {
    const user = userEvent.setup();
    const guild = baseGuild();
    seed(guild);
    // Gray all the way through.
    reader.pixels = new Uint8ClampedArray(ICON_SAMPLE * ICON_SAMPLE * 4).fill(128);
    render(<ServerColorField guild={guild} iconSrc="data:image/png;base64,AAAA" />);
    await user.click(screen.getByRole('button', { name: 'Match icon' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This icon has no color to match');
    expect(updateGuild).not.toHaveBeenCalled();

    reader.pixels = null;
    await user.click(screen.getByRole('button', { name: 'Match icon' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The icon could not be read'));
    expect(updateGuild).not.toHaveBeenCalled();
  });

  it('turns Match icon off for a server without an icon', () => {
    const guild = baseGuild();
    seed(guild);
    render(<ServerColorField guild={guild} iconSrc={null} />);
    expect(screen.getByRole('button', { name: 'Match icon' })).toBeDisabled();
  });

  it('keeps the old pick and says why when the server refuses it', async () => {
    const user = userEvent.setup();
    const guild = baseGuild({ hue: 36 });
    seed(guild);
    updateGuild.mockRejectedValueOnce(new Error('Missing permissions'));
    render(<ServerColorField guild={guild} iconSrc={null} />);
    await user.click(screen.getByRole('button', { name: 'Cobalt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server color was not saved');
    expect(screen.getByRole('button', { name: 'Gold' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Cobalt' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('is one Tab stop with arrows, Home and End moving between swatches', async () => {
    const user = userEvent.setup();
    const guild = baseGuild({ hue: 150 });
    seed(guild);
    render(<ServerColorField guild={guild} iconSrc={null} />);
    const group = screen.getByRole('group', { name: 'Server color swatches' });
    const swatches = within(group).getAllByRole('button');
    // The pressed swatch is the Tab stop; the rest are reachable by arrow.
    expect(swatches.filter((swatch) => swatch.tabIndex === 0).map((swatch) => swatch.getAttribute('aria-label'))).toEqual(['Green']);
    await act(async () => swatches[4].focus());
    await user.keyboard('{ArrowRight}');
    expect(swatches[5]).toHaveFocus();
    await user.keyboard('{End}');
    expect(swatches[10]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(swatches[0]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(swatches[0]).toHaveFocus();
    expect(updateGuild).not.toHaveBeenCalled();
  });
});
