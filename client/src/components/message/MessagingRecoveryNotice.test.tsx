import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MessagingRecoveryNotice } from './MessagingRecoveryNotice';
import { createMessagingPanelRuntime } from '../../test/messagingPanelRuntimeMock';

const DEVICE_KEY_LIMITATION =
  'Drafts use a device-bound encryption key. Recovery words alone cannot restore them; recovering this storage requires the complete device profile. Device encryption does not protect messages from code running in this app’s origin.';
const REENROLLMENT_LIMITATION =
  'Your recovery phrase restored the identity this account is enrolled under, and that identity is what everyone you talk to verifies. This device can publish fresh keys under it, and your contacts pick them up on their next message. Messages sent before now stay unreadable here: import the account’s encrypted backup from Settings › Identity portability if you need them. Any other device still signed in to this account stops receiving new conversations until it sets up again.';
const LEGACY_LIMITATION =
  'Older keys are retained because their instance ownership cannot be verified. Starting new encryption does not recover historical messages. Restore the original account backup if you need those keys; continue only to start a new session for this account.';

describe('MessagingRecoveryNotice', () => {
  it('renders nothing when storage and encryption are healthy', () => {
    const { runtime } = createMessagingPanelRuntime();
    const { container } = render(
      <MessagingRecoveryNotice runtime={runtime} encryptedConversation channelId="chan-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('waits for the authenticated connection without offering an action', () => {
    const { runtime } = createMessagingPanelRuntime({ storage: 'awaiting-handshake' });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation={false} channelId="chan-1" />);
    expect(screen.getByText('Waiting for this instance’s authenticated connection')).toBeInTheDocument();
    expect(
      screen.getByText('Your first drafts stay on this device until the instance confirms its history.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers previous-history review with device-key limitations visible', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({
      storage: 'review',
      error: 'The server database history changed. Review saved messages before sending into this history.',
    });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation={false} channelId="chan-1" />);
    expect(screen.getByText('Review messages from the previous instance history')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Preserve saved requests and open composer text as recovery drafts before starting fresh messages. Nothing from the previous history will send automatically.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(DEVICE_KEY_LIMITATION)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preserve old drafts and start fresh' }));
    await waitFor(() => expect(actions.preservePreviousHistoryForReview).toHaveBeenCalledTimes(1));
    expect(actions.startLocal).not.toHaveBeenCalled();
    expect(actions.enroll).not.toHaveBeenCalled();
  });

  it('shows the busy state while previous-history review is running', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({ storage: 'review' });
    let resolve: (() => void) | undefined;
    actions.preservePreviousHistoryForReview.mockImplementation(
      () => new Promise<void>(done => { resolve = done; }),
    );
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation={false} channelId="chan-1" />);
    const button = screen.getByRole('button', { name: 'Preserve old drafts and start fresh' });
    await user.click(button);
    expect(await screen.findByRole('button', { name: 'Working…' })).toBeDisabled();
    resolve!();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Preserve old drafts and start fresh' })).toBeEnabled(),
    );
  });

  it('retries device-key encrypted storage after a storage failure', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({
      storage: 'error',
      error: 'The device encryption key could not be read.',
    });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation={false} channelId="chan-1" />);
    expect(screen.getByText('Encrypted draft storage is unavailable')).toBeInTheDocument();
    expect(screen.getByText('The device encryption key could not be read.')).toBeInTheDocument();
    expect(screen.getByText(DEVICE_KEY_LIMITATION)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry encrypted storage' }));
    await waitFor(() => expect(actions.startLocal).toHaveBeenCalledTimes(1));
    expect(actions.preservePreviousHistoryForReview).not.toHaveBeenCalled();
  });

  it('retains the recovery error when a retry fails', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({ storage: 'error', error: 'first failure' });
    actions.startLocal.mockRejectedValue(new Error('Encrypted storage is still unavailable.'));
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation={false} channelId="chan-1" />);
    await user.click(screen.getByRole('button', { name: 'Retry encrypted storage' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Encrypted storage is still unavailable.');
    expect(screen.getByRole('button', { name: 'Retry encrypted storage' })).toBeEnabled();
  });

  it('retries plain encryption recovery through enrollment', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({
      encryption: 'recovery',
      encryptionError: 'Prekey enrollment failed.',
    });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation channelId="chan-1" />);
    expect(screen.getByText('Encryption needs recovery')).toBeInTheDocument();
    expect(screen.getByText('Prekey enrollment failed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry encryption recovery' }));
    await waitFor(() => expect(actions.enroll).toHaveBeenCalledTimes(1));
    expect(actions.enroll.mock.calls[0]).toHaveLength(0);
  });

  it('requires explicit initialization for unowned legacy prekeys', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({
      encryption: 'recovery',
      encryptionError: 'The server holds legacy keys this device did not create.',
      encryptionRecovery: { kind: 'legacy-prekeys' },
    });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation channelId="chan-1" />);
    expect(screen.getByText(LEGACY_LIMITATION)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep old keys and start new encryption' }));
    await waitFor(() => expect(actions.enroll).toHaveBeenCalledTimes(1));
    expect(actions.enroll).toHaveBeenCalledWith({ initializeWithUnownedLegacy: true });
    expect(actions.reviewLegacySession).not.toHaveBeenCalled();
  });

  it('offers a phrase-restored device its own keys, and says what that costs', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({
      encryption: 'recovery',
      encryptionError: 'This account published encryption keys from another device, and this device holds none of them.',
      encryptionRecovery: { kind: 'device-reenrollment' },
    });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation channelId="chan-1" />);
    expect(screen.getByText('Set up encryption keys on this device')).toBeInTheDocument();
    expect(screen.getByText(REENROLLMENT_LIMITATION)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish new keys for this device' }));
    await waitFor(() => expect(actions.enroll).toHaveBeenCalledTimes(1));
    expect(actions.enroll).toHaveBeenCalledWith({ replacePublishedBundle: true });
  });

  it('never offers re-enrollment in an unencrypted conversation', () => {
    const { runtime } = createMessagingPanelRuntime({
      encryption: 'recovery',
      encryptionError: 'This account published encryption keys from another device, and this device holds none of them.',
      encryptionRecovery: { kind: 'device-reenrollment' },
    });
    const { container } = render(
      <MessagingRecoveryNotice runtime={runtime} encryptedConversation={false} channelId="chan-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('routes legacy session review only for the matching conversation', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({
      encryptionRecovery: { kind: 'legacy-session', channelId: 'chan-1' },
      encryptionError: 'A legacy session needs review.',
    });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation channelId="chan-1" />);
    expect(screen.getByText('Encryption needs recovery')).toBeInTheDocument();
    expect(screen.getByText(LEGACY_LIMITATION)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep old keys and start new encryption' }));
    await waitFor(() => expect(actions.reviewLegacySession).toHaveBeenCalledWith('chan-1'));
    expect(actions.enroll).not.toHaveBeenCalled();
  });

  it('renders nothing when the legacy session error belongs to another channel', () => {
    const { runtime } = createMessagingPanelRuntime({
      encryptionRecovery: { kind: 'legacy-session', channelId: 'chan-2' },
      encryptionError: 'A legacy session needs review.',
    });
    const { container } = render(
      <MessagingRecoveryNotice runtime={runtime} encryptedConversation channelId="chan-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for legacy errors on unencrypted conversations', () => {
    const { runtime } = createMessagingPanelRuntime({
      encryption: 'recovery',
      encryptionRecovery: { kind: 'legacy-prekeys' },
      encryptionError: 'The server holds legacy keys this device did not create.',
    });
    const { container } = render(
      <MessagingRecoveryNotice runtime={runtime} encryptedConversation={false} channelId="chan-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
  it('never approves a different conversation from a generic recovery retry', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({ encryption: 'recovery', encryptionRecovery: { kind: 'legacy-session', channelId: 'chan-2' }, encryptionError: 'Other conversation needs recovery.' });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation channelId="chan-1" />);
    await user.click(screen.getByRole('button', { name: 'Retry encryption recovery' }));
    expect(actions.enroll).toHaveBeenCalledWith();
    expect(actions.reviewLegacySession).not.toHaveBeenCalled();
  });
  it('offers retry for a retained receive error even with an enrolled identity', async () => {
    const user = userEvent.setup();
    const { runtime, actions } = createMessagingPanelRuntime({ encryption: 'ready', encryptionError: 'A retained envelope needs recovery.' });
    render(<MessagingRecoveryNotice runtime={runtime} encryptedConversation channelId="chan-1" />);
    expect(screen.getByText('A retained envelope needs recovery.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry encryption recovery' }));
    expect(actions.enroll).toHaveBeenCalledWith();
  });

});
