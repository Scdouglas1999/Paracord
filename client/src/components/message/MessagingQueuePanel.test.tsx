import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessagingQueuePanel } from './MessagingQueuePanel';
import {
  createMessagingPanelRuntime,
  mutationRow,
  preparedSendRow,
  queuedIntentRow,
  recoveryDraftRow,
} from '../../test/messagingPanelRuntimeMock';

function stubClipboard(writeText = vi.fn(async (_text: string) => {})) {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe('MessagingQueuePanel', () => {
  it('renders nothing when no rows target the visible channel', () => {
    const { runtime } = createMessagingPanelRuntime({
      queue: [queuedIntentRow({ channelId: 'chan-2' })],
      mutations: [
        mutationRow({
          target: { channelId: 'chan-2', messageId: 'msg-9', authorId: 'user-1', encryption: { kind: 'plain' } },
        }),
      ],
      recovery: [recoveryDraftRow({ channelId: 'chan-2' })],
    });
    const { container } = render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('treats a policy refusal as terminal: the reason, Edit and Discard, never Retry', async () => {
    // An AutoMod block is a 403 the server will give again for the same bytes.
    // The generic durable-send row offered "Retry delivery" forever and told
    // the author the delivery "may already have committed" — a refusal is proof
    // it did not.
    const { runtime } = createMessagingPanelRuntime({
      queue: [
        preparedSendRow({
          status: 'failed',
          refused: true,
          error: 'Blocked by a server rule',
          draft: { content: 'the blocked line' },
        }),
      ],
    });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    expect(screen.getByText('Refused — not delivered')).toBeInTheDocument();
    expect(screen.getByText('Blocked by a server rule')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).not.toBeInTheDocument();
    expect(screen.queryByText(/may already have committed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit queued text' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit queued text' }));
    expect(screen.getByLabelText(/Replacement text/)).toHaveValue('the blocked line');
  });

  it('keeps Retry on a delivery that merely failed to land', () => {
    const { runtime } = createMessagingPanelRuntime({
      queue: [preparedSendRow({ status: 'failed', error: 'Network Error' })],
    });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    expect(screen.getByText('Delivery needs attention')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeInTheDocument();
  });

  it('shows pending and failed queued drafts with the delivery error', () => {
    const { runtime } = createMessagingPanelRuntime({
      queue: [
        queuedIntentRow(),
        queuedIntentRow({
          id: 'intent-2',
          nonce: 'nonce-2',
          sequence: 2,
          draft: { content: 'second body' },
          status: 'failed',
          error: 'Server rejected the send.',
        }),
      ],
    });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    expect(screen.getByText('Saved delivery and recovery (2)')).toBeInTheDocument();
    expect(screen.getByText('Queued message')).toBeInTheDocument();
    expect(screen.getByText('Delivery needs attention')).toBeInTheDocument();
    expect(screen.getByText('second body')).toBeInTheDocument();
    expect(screen.getByText('Server rejected the send.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry delivery' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Discard draft' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Copy text' })).toHaveLength(2);
  });

  it('restores recovered legacy text into an empty composer draft', async () => {
    const { runtime, draft } = createMessagingPanelRuntime({ recovery: [recoveryDraftRow({ content: 'legacy queued text' })] });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore into the composer' }));
    await waitFor(() => expect(draft.setContent).toHaveBeenCalledWith('legacy queued text'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('never overwrites a draft that already has text', async () => {
    const { runtime, draft } = createMessagingPanelRuntime({ recovery: [recoveryDraftRow({ content: 'legacy queued text' })] }, 'text already typed');
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore into the composer' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Clear this conversation’s draft'));
    expect(draft.setContent).not.toHaveBeenCalled();
  });

  it('copies a failed draft so the text is recoverable before discarding it', async () => {
    const writeText = stubClipboard();
    const { runtime } = createMessagingPanelRuntime({
      queue: [queuedIntentRow({ status: 'failed', error: 'Server rejected the send.', draft: { content: 'text worth keeping' } })],
    });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('text worth keeping'));
  });

  it('discards a queued draft passing the exact row record', async () => {
    const user = userEvent.setup();
    const row = queuedIntentRow();
    const { runtime, actions } = createMessagingPanelRuntime({ queue: [row] });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(actions.queueAction).toHaveBeenCalledTimes(1));
    const [passedRow, action] = actions.queueAction.mock.calls[0];
    expect(passedRow).toBe(row);
    expect(action).toBe('discard');
    if (!('revision' in passedRow.record)) throw new Error('Expected a draft intent record.');
    expect(passedRow.record.revision).toBe('rev-1');
  });

  it('saves a queued edit with the replacement text and exact record', async () => {
    const user = userEvent.setup();
    const row = queuedIntentRow();
    const { runtime, actions } = createMessagingPanelRuntime({ queue: [row] });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await user.click(screen.getByRole('button', { name: 'Edit queued text' }));
    const textarea = screen.getByLabelText('Replacement text');
    expect(textarea).toHaveValue('queued body');
    await user.clear(textarea);
    await user.type(textarea, 'replacement body');
    await user.click(screen.getByRole('button', { name: 'Save queued edit' }));
    await waitFor(() => expect(actions.queueAction).toHaveBeenCalledTimes(1));
    expect(actions.queueAction.mock.calls[0][0]).toBe(row);
    expect(actions.queueAction.mock.calls[0][1]).toBe('edit');
    expect(actions.queueAction.mock.calls[0][2]).toBe('replacement body');
    await waitFor(() => expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument());
  });

  it('keeps the action error visible when a queue action fails', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({ queue: [queuedIntentRow()] });
    actions.queueAction.mockRejectedValue(new Error('The draft changed in another window.'));
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await user.click(screen.getByRole('button', { name: 'Retry delivery' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The draft changed in another window.');
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeEnabled();
  });

  it('marks a prepared discard as resolving and locks edit/discard controls', async () => {
    const user = userEvent.setup();
    const row = preparedSendRow({ mutation: { kind: 'discard' } });
    const { runtime, actions } = createMessagingPanelRuntime({ queue: [row] });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    expect(screen.getByText('Resolving discard')).toBeInTheDocument();
    expect(
      screen.getByText('Delivery may already have committed. Editing or discarding resolves the original request first.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve and discard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit queued text' })).toBeDisabled();
    const retry = screen.getByRole('button', { name: 'Retry delivery' });
    expect(retry).toBeEnabled();
    await user.click(retry);
    await waitFor(() => expect(actions.queueAction).toHaveBeenCalledWith(row, 'retry', 'queued body'));
  });

  it('retries a saved mutation with the exact row record', async () => {
    const user = userEvent.setup();
    const row = mutationRow({ draft: { content: 'edited body' }, error: 'Edit conflicted.' });
    const { runtime, actions } = createMessagingPanelRuntime({ mutations: [row] });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    expect(screen.getByText('Saved message edit')).toBeInTheDocument();
    expect(screen.getByText('edited body')).toBeInTheDocument();
    expect(screen.getByText('Edit conflicted.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry saved change' }));
    await waitFor(() => expect(actions.retryMutation).toHaveBeenCalledTimes(1));
    expect(actions.retryMutation.mock.calls[0][0]).toBe(row);
    expect(actions.retryMutation.mock.calls[0][0].record.revision).toBe('rev-m1');
  });

  it('retains the mutation error when a saved-change retry fails', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({ mutations: [mutationRow()] });
    actions.retryMutation.mockRejectedValue(new Error('The message was already edited.'));
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await user.click(screen.getByRole('button', { name: 'Retry saved change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The message was already edited.');
  });

  it('hides mutation retry for deleted targets and omits copy without a draft', () => {
    const { runtime } = createMessagingPanelRuntime({
      mutations: [
        mutationRow({
          intent: { kind: 'delete', deleteNonce: 'delete-nonce-1' },
          targetDeleted: true,
        }),
      ],
    });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    expect(screen.getByText('Saved deletion')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry saved change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy retained text' })).not.toBeInTheDocument();
  });

  it('copies retained mutation and recovery text to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    const { runtime } = createMessagingPanelRuntime({
      mutations: [mutationRow({ draft: { content: 'kept edit text' } })],
      recovery: [recoveryDraftRow({ content: 'recovered body', reason: 'Recovered from legacy storage.' })],
    });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    expect(screen.getByText('Recovery draft')).toBeInTheDocument();
    expect(screen.getByText('Recovered from legacy storage.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy retained text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('kept edit text'));
    await user.click(screen.getByRole('button', { name: 'Copy recovery text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('recovered body'));
  });

  it('reports clipboard failures instead of copying', async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn(async (_text: string) => { throw new Error('denied'); }));
    const { runtime } = createMessagingPanelRuntime({ recovery: [recoveryDraftRow()] });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await user.click(screen.getByRole('button', { name: 'Copy recovery text' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The clipboard is unavailable. Select and copy the retained text.',
    );
  });
  it('keeps the revision captured when an editor opened even if another window changes the queue', async () => {
    const user = userEvent.setup(); const row = queuedIntentRow();
    const { runtime, actions } = createMessagingPanelRuntime({ queue: [row] });
    render(<MessagingQueuePanel runtime={runtime} channelId="chan-1" />);
    await user.click(screen.getByRole('button', { name: 'Edit queued text' }));
    await user.type(screen.getByLabelText('Replacement text'), ' my edit');
    act(() => runtime.store.setState({ queue: [queuedIntentRow({ revision: 'other-window-revision', draft: { content: 'Other window text' } })] }));
    actions.queueAction.mockRejectedValueOnce(new Error('Review the latest queued draft.'));
    await user.click(screen.getByRole('button', { name: 'Save queued edit' }));
    expect(actions.queueAction.mock.calls[0][0]).toBe(row);
    expect(screen.getByLabelText('Replacement text')).toHaveValue('queued body my edit');
    expect(await screen.findByRole('alert')).toHaveTextContent('Review the latest queued draft.');
  });

});
