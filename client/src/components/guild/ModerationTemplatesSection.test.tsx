import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModerationTemplatesSection } from './GuildSettingsSections';
import type { ModerationTemplate } from '../../api/moderationTemplates';

const template: ModerationTemplate = {
  id: 'tmpl-1',
  guild_id: 'g1',
  name: 'Spam Warning',
  action_type: 1,
  duration_minutes: null,
  reason_template: '{target} posted spam',
  dm_template: 'Please stop spamming in {guild}',
  created_by: 'u1',
  created_at: '2026-05-17T00:00:00Z',
  updated_at: '2026-05-17T00:00:00Z',
};

describe('ModerationTemplatesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a timed mute template and resets the form after save', async () => {
    const user = userEvent.setup();
    const onCreateTemplate = vi.fn().mockResolvedValue(undefined);

    render(
      <ModerationTemplatesSection
        templates={[]}
        onCreateTemplate={onCreateTemplate}
        onDeleteTemplate={vi.fn()}
        onApplyTemplate={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('Template name'), 'Raid mute');
    await user.selectOptions(screen.getByLabelText('Action type'), '2');
    await user.clear(screen.getByLabelText('Duration in minutes'));
    await user.type(screen.getByLabelText('Duration in minutes'), '45');
    fireEvent.change(screen.getByLabelText('Reason template'), {
      target: { value: '{target} joined a raid' },
    });
    fireEvent.change(screen.getByLabelText('DM template'), {
      target: { value: 'Muted for: {reason}' },
    });
    await user.click(screen.getByRole('button', { name: 'Create Template' }));

    await waitFor(() => {
      expect(onCreateTemplate).toHaveBeenCalledWith({
        name: 'Raid mute',
        action_type: 2,
        duration_minutes: 45,
        reason_template: '{target} joined a raid',
        dm_template: 'Muted for: {reason}',
      });
    });

    expect(screen.getByLabelText('Template name')).toHaveValue('');
    expect(screen.getByLabelText('Action type')).toHaveValue('1');
  });

  it('keeps create disabled until a template name is present', async () => {
    const user = userEvent.setup();
    const onCreateTemplate = vi.fn();

    render(
      <ModerationTemplatesSection
        templates={[]}
        onCreateTemplate={onCreateTemplate}
        onDeleteTemplate={vi.fn()}
        onApplyTemplate={vi.fn()}
      />,
    );

    const createButton = screen.getByRole('button', { name: 'Create Template' });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByLabelText('Template name'), 'Kick macro');
    expect(createButton).toBeEnabled();
  });

  it('renders existing templates and deletes by template id', async () => {
    const user = userEvent.setup();
    const onDeleteTemplate = vi.fn();

    render(
      <ModerationTemplatesSection
        templates={[template]}
        onCreateTemplate={vi.fn()}
        onDeleteTemplate={onDeleteTemplate}
        onApplyTemplate={vi.fn()}
      />,
    );

    expect(screen.getByText('Spam Warning')).toBeInTheDocument();
    expect(screen.getAllByText('Warn')).toHaveLength(2);
    expect(screen.getByText('Reason: {target} posted spam')).toBeInTheDocument();
    expect(screen.getByText('DM: Please stop spamming in {guild}')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete moderation template Spam Warning' }));

    expect(onDeleteTemplate).toHaveBeenCalledWith('tmpl-1');
  });

  it('applies an existing template to a target member with optional overrides', async () => {
    const user = userEvent.setup();
    const onApplyTemplate = vi.fn().mockResolvedValue(undefined);

    render(
      <ModerationTemplatesSection
        templates={[template]}
        onCreateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        onApplyTemplate={onApplyTemplate}
      />,
    );

    const applyButton = screen.getByRole('button', { name: 'Apply Template' });
    expect(applyButton).toBeDisabled();

    await user.type(screen.getByLabelText('Target user ID for Spam Warning'), 'user-123');
    await user.type(screen.getByLabelText('Reason override for Spam Warning'), 'Repeated spam');
    await user.type(screen.getByLabelText('DM override for Spam Warning'), 'Please stop posting spam.');
    await user.click(applyButton);

    await waitFor(() => {
      expect(onApplyTemplate).toHaveBeenCalledWith('tmpl-1', {
        target_user_id: 'user-123',
        reason: 'Repeated spam',
        dm_message: 'Please stop posting spam.',
      });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Template applied.');
    expect(screen.getByLabelText('Target user ID for Spam Warning')).toHaveValue('');
  });

  it('shows the empty state when there are no templates', () => {
    render(
      <ModerationTemplatesSection
        templates={[]}
        onCreateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        onApplyTemplate={vi.fn()}
      />,
    );

    expect(screen.getByText('No moderation templates yet.')).toBeInTheDocument();
  });
});
