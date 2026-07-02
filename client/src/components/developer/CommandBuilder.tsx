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

  return (
    <div
      className={cn(
        'rounded-lg border border-border-subtle bg-bg-primary/30 p-3 space-y-2',
        depth > 0 && 'ml-4',
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} option ${index + 1}`}
          className="text-text-muted hover:text-text-primary"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="text-xs font-semibold text-text-secondary">
          Option {index + 1}
        </span>
        {option.name && (
          <span className="text-xs text-text-muted">({option.name})</span>
        )}
        <button
          type="button"
          aria-label={`Remove option ${index + 1}`}
          className="ml-auto text-accent-danger hover:text-accent-danger/80"
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
            <input
              className={cn('input-field text-xs', option.name && !NAME_REGEX.test(option.name) && 'border-accent-danger/50')}
              placeholder="Name (lowercase, no spaces)"
              value={option.name}
              maxLength={32}
              onChange={(e) => updateField('name', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
            />
            <input
              className="input-field text-xs"
              placeholder="Description"
              value={option.description}
              maxLength={100}
              onChange={(e) => updateField('description', e.target.value)}
            />
            <select
              className="input-field text-xs"
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
            </select>
            <label className="flex items-center gap-1.5 text-xs text-text-secondary">
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
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  Choices (optional)
                </span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-primary hover:underline"
                  onClick={addChoice}
                >
                  <Plus size={11} /> Add
                </button>
              </div>
              {(option.choices ?? []).map((choice, ci) => (
                <div key={ci} className="flex items-center gap-2">
                  <input
                    className="input-field flex-1 text-xs"
                    placeholder="Choice name"
                    value={choice.name}
                    onChange={(e) => updateChoice(ci, 'name', e.target.value)}
                  />
                  <input
                    className="input-field flex-1 text-xs"
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
                    className="text-accent-danger hover:text-accent-danger/80"
                    onClick={() => removeChoice(ci)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Nested options for SubCommand / SubCommandGroup */}
          {supportsNestedOptions(option.type) && depth < 2 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  Sub-Options
                </span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-primary hover:underline"
                  onClick={addNestedOption}
                >
                  <Plus size={11} /> Add
                </button>
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
    <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-text-primary">
        {editingCommand ? 'Edit Command' : 'Create Command'}
      </h3>

      {error && (
        <div role="alert" className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-xs font-medium text-accent-danger">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Name
          </label>
          <input
            aria-label="Command name"
            className={cn(
              'input-field text-sm',
              name.length > 0 && !nameValid && 'border-accent-danger/60',
            )}
            placeholder="command-name"
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s/g, '-'))}
          />
          {name.length > 0 && !nameValid && (
            <p className="mt-1 text-[11px] text-accent-danger">
              Letters, numbers, hyphens, underscores only (1-32 chars)
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Description
          </label>
          <input
            aria-label="Command description"
            className="input-field text-sm"
            placeholder="A brief description"
            value={description}
            maxLength={100}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-text-muted">{description.length}/100</p>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Type
          </label>
          <select
            aria-label="Command type"
            className="input-field text-sm"
            value={type}
            onChange={(e) => setType(Number(e.target.value) as ApplicationCommandType)}
          >
            {Object.entries(COMMAND_TYPE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Options builder - only for ChatInput */}
      {type === ApplicationCommandType.ChatInput && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Options
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
              onClick={addOption}
            >
              <Plus size={12} /> Add Option
            </button>
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
            <p className="text-xs text-text-muted">No options. Click "Add Option" to define parameters.</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          className="btn-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {saving ? 'Saving...' : editingCommand ? 'Update Command' : 'Create Command'}
        </button>
        <button
          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
