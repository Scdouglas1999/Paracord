import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsSectionHeader, SettingsShell } from './SettingsShell';

/**
 * Settings (docs/index-spec.md §6.7): a full-window surface on the ground, a 240px
 * index with the hue selection, a column with a 28/700 title, close and Esc at
 * the top right.
 */

const GROUPS = [
  { items: [{ id: 'account', label: 'My account' }] },
  { label: 'Preferences', items: [{ id: 'voice', label: 'Voice and video' }] },
];

function renderShell(hue?: number) {
  return render(
    <SettingsShell
      label="Server settings"
      title="Fuel"
      subtitle="Server settings"
      lead={<span data-testid="lead">F</span>}
      hue={hue}
      groups={GROUPS}
      active="voice"
      onSelect={() => {}}
      onClose={() => {}}
      closeLabel="Close server settings"
    >
      <SettingsSectionHeader title="Voice and video" description="Pick the microphone you use." />
    </SettingsShell>,
  );
}

describe('SettingsShell (Index)', () => {
  it('is the full-window settings surface in the Index scope, with the index on the sidebar gradient', () => {
    const { container } = renderShell();
    const shell = container.firstElementChild as HTMLElement;
    expect(shell).toHaveClass('ix-settings', 'ix-lt');
    expect(screen.getByRole('navigation', { name: 'Server settings' })).toHaveClass('ix-settings__nav', 'ix-hue-side');
    expect(container.querySelector('.ix-settings__main')).toHaveClass('ix-hue-main');
  });

  it("sets the window's hue (People's 210 by default) and the selected row wears it", () => {
    const { container, rerender } = renderShell();
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--ix-hue')).toBe('210');
    expect(screen.getByRole('button', { name: 'Voice and video' })).toHaveClass('ix-hue-selected');
    expect(screen.getByRole('button', { name: 'My account' })).not.toHaveClass('ix-hue-selected');
    rerender(
      <SettingsShell
        label="Server settings"
        title="Fuel"
        hue={350}
        groups={GROUPS}
        active="voice"
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel="Close server settings"
      >
        x
      </SettingsShell>,
    );
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--ix-hue')).toBe('350');
  });

  it('heads the index with the mark, the name and the line under it', () => {
    renderShell();
    expect(screen.getByTestId('lead')).toBeInTheDocument();
    expect(screen.getByText('Fuel')).toHaveClass('ix-settings__name');
    expect(screen.getAllByText('Server settings').some((node) => node.classList.contains('ix-settings__line'))).toBe(true);
  });

  it('group labels are sentence case; the section title is the 28/700 title in the column', () => {
    const { container } = renderShell();
    expect(screen.getByText('Preferences').parentElement?.className).not.toMatch(/uppercase|glass-kicker/);
    const title = screen.getByRole('heading', { name: 'Voice and video' });
    expect(title).toHaveClass('ix-settings__title');
    expect(container.querySelector('.ix-settings__col')).toContainElement(title);
  });

  it('close is a control at the top right with Esc under it', () => {
    const { container } = renderShell();
    const close = container.querySelector('.ix-settings__close') as HTMLElement;
    expect(close).toContainElement(screen.getByRole('button', { name: 'Close server settings' }));
    expect(close.querySelector('kbd')).toHaveTextContent('Esc');
  });
});
