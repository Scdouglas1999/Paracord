import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal, ModalTitle } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Textarea } from '../ui/Input';
import { ComponentType, TextInputStyle, type Component } from '../../types/components';
import { InteractionType } from '../../types/interactions';
import { getApi } from '../../api/activeClient';
import { extractApiError } from '../../api/client';
import { useInteractionStore } from '../../stores/interactionStore';
import { toast } from '../../stores/toastStore';

function collectTextInputs(components: Component[]): Component[] {
  const inputs: Component[] = [];
  for (const row of components) {
    if (row.type === ComponentType.ActionRow && row.components) {
      for (const child of row.components) {
        if (child.type === ComponentType.TextInput) inputs.push(child);
      }
    } else if (row.type === ComponentType.TextInput) {
      inputs.push(row);
    }
  }
  return inputs;
}

/**
 * Renders a bot-supplied interaction modal (callback type 9) for the invoking user.
 * Submits as a ModalSubmit interaction.
 */
export function InteractionModal() {
  const activeModal = useInteractionStore((s) => s.activeModal);
  const clearModal = useInteractionStore((s) => s.clearModal);
  const textInputs = useMemo(
    () => (activeModal ? collectTextInputs(activeModal.components) : []),
    [activeModal],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!activeModal) {
      setValues({});
      return;
    }
    const initial: Record<string, string> = {};
    for (const input of collectTextInputs(activeModal.components)) {
      if (input.custom_id) initial[input.custom_id] = input.value ?? '';
    }
    setValues(initial);
  }, [activeModal]);

  if (!activeModal) return null;

  const submit = async () => {
    setSubmitting(true);
    try {
      const components = activeModal.components.map((row) => {
        if (row.type !== ComponentType.ActionRow || !row.components) return row;
        return {
          ...row,
          components: row.components.map((child) => {
            if (child.type !== ComponentType.TextInput || !child.custom_id) return child;
            return { ...child, value: values[child.custom_id] ?? '' };
          }),
        };
      });
      if (!activeModal.channelId || !activeModal.guildId || !activeModal.applicationId) {
        toast.error('Modal is missing channel or guild context. Dismiss and try again.');
        return;
      }
      await getApi().post('/interactions', {
        type: InteractionType.ModalSubmit,
        channel_id: activeModal.channelId,
        guild_id: activeModal.guildId,
        application_id: activeModal.applicationId,
        source_interaction_id: activeModal.interactionId,
        custom_id: activeModal.customId,
        data: {
          custom_id: activeModal.customId,
          components,
        },
      });
      clearModal();
    } catch (err) {
      toast.error(`Failed to submit modal: ${extractApiError(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={clearModal}
      labelledBy="interaction-modal-title"
      size="md"
      showCloseButton
    >
      <ModalTitle id="interaction-modal-title">{activeModal.title}</ModalTitle>
      <div className="mt-4 flex flex-col gap-3">
        {textInputs.map((input) => {
          const id = input.custom_id ?? '';
          const isParagraph = input.style === TextInputStyle.Paragraph;
          return (
            <label key={id} className="flex flex-col gap-1.5">
              <span className="text-label font-semibold text-text-secondary">
                {input.label ?? id}
                {input.required !== false ? ' *' : ''}
              </span>
              {isParagraph ? (
                <Textarea
                  value={values[id] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [id]: e.target.value }))}
                  placeholder={input.placeholder}
                  maxLength={input.max_length}
                  required={input.required !== false}
                  rows={4}
                />
              ) : (
                <Input
                  value={values[id] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [id]: e.target.value }))}
                  placeholder={input.placeholder}
                  maxLength={input.max_length}
                  required={input.required !== false}
                />
              )}
            </label>
          );
        })}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={clearModal} disabled={submitting}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={submitting}>
          {submitting ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" /> Submitting…
            </span>
          ) : (
            'Submit'
          )}
        </Button>
      </div>
    </Modal>
  );
}
