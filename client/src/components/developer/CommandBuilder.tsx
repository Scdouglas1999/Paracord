import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import {
  ApplicationCommandType,
  CommandOptionType,
  type ApplicationCommand,
  type CommandOption,
  type CommandOptionChoice,
} from '../../types/commands';
import { commandApi, type CreateCommandRequest } from '../../api/commands';
import { extractApiError } from '../../api/client';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Input';

interface CommandBuilderProps {
  appId: string;
  editingCommand?: ApplicationCommand;
  onSaved: () => void;
  onCancel: () => void;
}

const COMMAND_TYPE_LABELS: Record<number, string> = {
  [ApplicationCommandType.ChatInput]: 'Chat Input (Slash)',
  [ApplicationCommandType.User]: 'User Context Menu',
  [ApplicationCommandType.Message]: 'Message Context Menu',
};

const OPTION_TYPE_LABELS: Record<number, string> = {
  [CommandOptionType.SubCommand]: 'Sub Command',
  [CommandOptionType.SubCommandGroup]: 'Sub Command Group',
  [CommandOptionType.String]: 'String',
  [CommandOptionType.Integer]: 'Integer',
  [CommandOptionType.Boolean]: 'Boolean',
  [CommandOptionType.User]: 'User',
  [CommandOptionType.Channel]: 'Channel',
  [CommandOptionType.Role]: 'Role',
  [CommandOptionType.Mentionable]: 'Mentionable',
  [CommandOptionType.Number]: 'Number',
  [CommandOptionType.Attachment]: 'Attachment',
};

const NAME_REGEX = /^[\w-]{1,32}$/;

function supportsChoices(type: CommandOptionType): boolean {
  return (
    type === CommandOptionType.String ||
    type === CommandOptionType.Integer ||
    type === CommandOptionType.Number
  );
}

function supportsNestedOptions(type: CommandOptionType): boolean {
  return (
    type === CommandOptionType.SubCommand ||
    type === CommandOptionType.SubCommandGroup
  );
}

// A quiet inline "add" affordance shared by choices/sub-options.
function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)]"
    >
      <Plus size={12} /> {label}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-section uppercase text-text-muted">{children}</span>;
}

// ---- Option Editor ----

interface OptionEditorProps {
  option: CommandOption;
  index: number;
  depth: number;
  onChange: (updated: CommandOption) => void;
  onRemove: () => void;
}

function OptionEditor({ option, index, depth, onChange, onRemove }: OptionEditorProps) {
  const [expanded, setExpanded] = useState(true);

  const updateField = <K extends keyof CommandOption>(key: K, val: CommandOption[K]) => {
    onChange({ ...option, [key]: val });
  };

  const addChoice = () => {
    const choices = option.choices ?? [];
    updateField('choices', [...choices, { name: '', value: '' }]);
  };

  const updateChoice = (ci: number, field: keyof CommandOptionChoice, val: string | number) => {
    const choices = [...(option.choices ?? [])];
    choices[ci] = { ...choices[ci], [field]: val };
    updateField('choices', choices);
  };

  const removeChoice = (ci: number) => {
    const choices = (option.choices ?? []).filter((_, i) => i !== ci);
    updateField('choices', choices.length > 0 ? choices : undefined);
  };

  const addNestedOption = () => {
    const opts = option.options ?? [];
    updateField('options', [
      ...opts,
      { name: '', description: '', type: CommandOptionType.String, required: false },
    ]);
  };

  const updateNestedOption = (oi: number, updated: CommandOption) => {
    const opts = [...(option.options ?? [])];
    opts[oi] = updated;
    updateField('options', opts);
  };

  const removeNestedOption = (oi: number) => {
    const opts = (option.options ?? []).filter((_, i) => i !== oi);
    updateField('options', opts.length > 0 ? opts : undefined);
  };

  const nameInvalid = Boolean(option.name && !NAME_REGEX.test(option.name));

  return (
    <div
      className={cn(
        'space-y-3 rounded-sm border border-border-subtle bg-bg-mod-subtle p-3',
        depth > 0 && 'ml-4',
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} option ${index + 1}`}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="text-label text-text-primary">Option {index + 1}</span>
        {option.name && (
          <code className="font-code text-meta text-text-muted">{option.name}</code>
        )}
        <button
          type="button"
          aria-label={`Remove option ${index + 1}`}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-danger hover:text-text-on-danger focus-visible:shadow-[var(--focus-ring)]"
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {expanded && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
            <Input
              className="h-9"
              error={nameInvalid}
              placeholder="Name (lowercase, no spaces)"
              value={option.name}
              maxLength={32}
              onChange={(e) => updateField('name', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
            />
            <Input
              className="h-9"
              placeholder="Description"
              value={option.description}
              maxLength={100}
              onChange={(e) => updateField('description', e.target.value)}
            />
            <Select
              className="h-9"
              value={option.type}
              onChange={(e) => {
                const newType = Number(e.target.value) as CommandOptionType;
                const updated: CommandOption = {
                  ...option,
                  type: newType,
                };
                // Clear choices if switching to type that doesn't support them
                if (!supportsChoices(newType)) {
                  delete updated.choices;
                }
                // Clear nested options if switching away from sub command types
                if (!supportsNestedOptions(newType)) {
                  delete updated.options;
                }
                onChange(updated);
              }}
            >
              {Object.entries(OPTION_TYPE_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </Select>
            <label className="flex items-center gap-1.5 px-1 text-label text-text-secondary">
              <input
                type="checkbox"
                checked={option.required ?? false}
                onChange={(e) => updateField('required', e.target.checked)}
                className="accent-accent-primary"
              />
              Required
            </label>
          </div>

          {/* Choices */}
          {supportsChoices(option.type) && (
            <div className="space-y-2 border-t border-border-subtle pt-3">
              <div className="flex items-center gap-2">
                <SectionLabel>Choices (optional)</SectionLabel>
                <AddButton label="Add" onClick={addChoice} />
              </div>
              {(option.choices ?? []).map((choice, ci) => (
                <div key={ci} className="flex items-center gap-2">
                  <Input
                    className="h-9 flex-1"
                    placeholder="Choice name"
                    value={choice.name}
                    onChange={(e) => updateChoice(ci, 'name', e.target.value)}
                  />
                  <Input
                    className="h-9 flex-1"
                    placeholder="Choice value"
                    value={String(choice.value)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const val =
                        option.type === CommandOptionType.Integer ||
                        option.type === CommandOptionType.Number
                          ? (Number(raw) || 0)
                          : raw;
                      updateChoice(ci, 'value', val);
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove choice ${ci + 1} from option ${index + 1}`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-danger hover:text-text-on-danger focus-visible:shadow-[var(--focus-ring)]"
                    onClick={() => removeChoice(ci)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Nested options for SubCommand / SubCommandGroup */}
          {supportsNestedOptions(option.type) && depth < 2 && (
            <div className="space-y-2 border-t border-border-subtle pt-3">
              <div className="flex items-center gap-2">
                <SectionLabel>Sub-options</SectionLabel>
                <AddButton label="Add" onClick={addNestedOption} />
              </div>
              {(option.options ?? []).map((sub, oi) => (
                <OptionEditor
                  key={oi}
                  option={sub}
                  index={oi}
                  depth={depth + 1}
                  onChange={(updated) => updateNestedOption(oi, updated)}
                  onRemove={() => removeNestedOption(oi)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Main CommandBuilder ----

export function CommandBuilder({ appId, editingCommand, onSaved, onCancel }: CommandBuilderProps) {
  const [name, setName] = useState(editingCommand?.name ?? '');
  const [description, setDescription] = useState(editingCommand?.description ?? '');
  const [type, setType] = useState<ApplicationCommandType>(
    editingCommand?.type ?? ApplicationCommandType.ChatInput,
  );
  const [options, setOptions] = useState<CommandOption[]>(editingCommand?.options ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = NAME_REGEX.test(name);
  const descValid = description.length >= 1 && description.length <= 100;
  const canSubmit = nameValid && descValid && !saving;

  const addOption = () => {
    setOptions((prev) => [
      ...prev,
      { name: '', description: '', type: CommandOptionType.String, required: false },
    ]);
  };

  const updateOption = (index: number, updated: CommandOption) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? updated : o)));
  };

  const removeOption = (index: number) => {
    setOptions((prev) => prev.filter((_, i) => i !== index));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);

    const payload: CreateCommandRequest = {
      name,
      description,
      type,
      options: options.length > 0 ? options : undefined,
    };

    try {
      if (editingCommand) {
        await commandApi.updateGlobalCommand(appId, editingCommand.id, payload);
      } else {
        await commandApi.createGlobalCommand(appId, payload);
      }
      onSaved();
    } catch (err) {
      const action = editingCommand ? 'Failed to update command' : 'Failed to create command';
      setError(`${action}: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
      <h3 className="font-display text-heading text-text-primary">
        {editingCommand ? 'Edit command' : 'Create command'}
      </h3>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-sm bg-danger-tint px-3 py-2 text-meta font-medium text-accent-danger"
        >
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <label className="mb-1.5 block text-section uppercase text-text-muted">Name</label>
          <Input
            aria-label="Command name"
            error={name.length > 0 && !nameValid}
            placeholder="command-name"
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s/g, '-'))}
          />
          {name.length > 0 && !nameValid && (
            <p className="mt-1 text-meta text-accent-danger">
              Letters, numbers, hyphens, underscores only (1–32 chars)
            </p>
          )}
        </div>
        <div>
          <label className="mb-1.5 block text-section uppercase text-text-muted">Description</label>
          <Input
            aria-label="Command description"
            placeholder="A brief description"
            value={description}
            maxLength={100}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="mt-1 text-meta tabular-nums text-text-muted">{description.length}/100</p>
        </div>
        <div>
          <label className="mb-1.5 block text-section uppercase text-text-muted">Type</label>
          <Select
            aria-label="Command type"
            value={type}
            onChange={(e) => setType(Number(e.target.value) as ApplicationCommandType)}
          >
            {Object.entries(COMMAND_TYPE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </Select>
        </div>
      </div>

      {/* Options builder - only for ChatInput */}
      {type === ApplicationCommandType.ChatInput && (
        <div className="space-y-2.5 border-t border-border-subtle pt-4">
          <div className="flex items-center justify-between">
            <SectionLabel>Options</SectionLabel>
            <Button size="sm" variant="secondary" onClick={addOption}>
              <Plus size={13} className="mr-1" /> Add Option
            </Button>
          </div>
          {options.map((opt, i) => (
            <OptionEditor
              key={i}
              option={opt}
              index={i}
              depth={0}
              onChange={(updated) => updateOption(i, updated)}
              onRemove={() => removeOption(i)}
            />
          ))}
          {options.length === 0 && (
            <p className="text-meta text-text-muted">
              No parameters yet. Add an option to accept arguments from users.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2.5 border-t border-border-subtle pt-4">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!canSubmit} loading={saving} onClick={() => void submit()}>
          {saving ? 'Saving…' : editingCommand ? 'Update Command' : 'Create Command'}
        </Button>
      </div>
    </div>
  );
}
