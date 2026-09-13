import { useId, useState } from 'react';
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
import { Button, Divider, ErrorBanner, IconButton, Raised, Switch, TextField } from '../ui';
import { Select } from '../ui/Input';

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
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={onClick}
      className="text-accent-primary"
    >
      <Plus size={12} aria-hidden /> {label}
    </Button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-section text-text-faint">{children}</span>;
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
  const requiredId = useId();

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
        // Parted by a hairline, never boxed: depth in this form belongs to the
        // fields, which already carry the well recipe (§1.6, §6.8).
        'flex flex-col gap-3 border-t border-border-subtle pt-3',
        depth > 0 && 'ml-4',
      )}
    >
      <div className="flex items-center gap-2">
        <IconButton
          label={`${expanded ? 'Collapse' : 'Expand'} option ${index + 1}`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </IconButton>
        <span className="text-label text-text-primary">Option {index + 1}</span>
        {option.name && <code className="pc-mono text-meta text-text-muted">{option.name}</code>}
        <IconButton
          label={`Remove option ${index + 1}`}
          className="ml-auto hover:bg-danger-well hover:text-accent-danger"
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </IconButton>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3">
          <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
            <TextField
              label={`Option ${index + 1} name`}
              hideLabel
              error={nameInvalid ? 'Lowercase letters, numbers, hyphens and underscores only' : undefined}
              placeholder="Name (lowercase, no spaces)"
              value={option.name}
              maxLength={32}
              onChange={(e) => updateField('name', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
            />
            <TextField
              label={`Option ${index + 1} description`}
              hideLabel
              placeholder="Description"
              value={option.description}
              maxLength={100}
              onChange={(e) => updateField('description', e.target.value)}
            />
            <Select
              aria-label={`Option ${index + 1} type`}
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
            <div className="flex h-[var(--h-control-phone)] items-center gap-2 px-1">
              <span id={requiredId} className="text-label text-text-secondary">Required</span>
              <Switch
                size="sm"
                checked={option.required ?? false}
                onChange={(next) => updateField('required', next)}
                labelledBy={requiredId}
              />
            </div>
          </div>

          {/* Choices */}
          {supportsChoices(option.type) && (
            <div className="flex flex-col gap-2">
              <Divider />
              <div className="flex items-center gap-2">
                <FieldLabel>Choices (optional)</FieldLabel>
                <AddButton label="Add" onClick={addChoice} />
              </div>
              {(option.choices ?? []).map((choice, ci) => (
                <div key={ci} className="flex items-center gap-2">
                  <TextField
                    label={`Choice ${ci + 1} name for option ${index + 1}`}
                    hideLabel
                    className="flex-1"
                    placeholder="Choice name"
                    value={choice.name}
                    onChange={(e) => updateChoice(ci, 'name', e.target.value)}
                  />
                  <TextField
                    label={`Choice ${ci + 1} value for option ${index + 1}`}
                    hideLabel
                    className="flex-1"
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
                  <IconButton
                    label={`Remove choice ${ci + 1} from option ${index + 1}`}
                    className="hover:bg-danger-well hover:text-accent-danger"
                    onClick={() => removeChoice(ci)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}

          {/* Nested options for SubCommand / SubCommandGroup */}
          {supportsNestedOptions(option.type) && depth < 2 && (
            <div className="flex flex-col gap-2">
              <Divider />
              <div className="flex items-center gap-2">
                <FieldLabel>Sub-options</FieldLabel>
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
  const formId = useId();
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
    <Raised className="flex flex-col gap-5 p-5">
      <h3 className="pc-display text-heading text-text-primary">
        {editingCommand ? 'Edit command' : 'Create command'}
      </h3>

      {error && <ErrorBanner message={error} multiline />}

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <TextField
          id={`${formId}-command-name`}
          label="Command name"
          error={
            name.length > 0 && !nameValid
              ? 'Letters, numbers, hyphens, underscores only (1–32 chars)'
              : undefined
          }
          placeholder="command-name"
          value={name}
          maxLength={32}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s/g, '-'))}
        />
        <TextField
          id={`${formId}-command-description`}
          label="Command description"
          hint={`${description.length}/100`}
          placeholder="A brief description"
          value={description}
          maxLength={100}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`${formId}-command-type`}
            className="text-label font-medium text-text-secondary"
          >
            Command type
          </label>
          <Select
            id={`${formId}-command-type`}
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
        <div className="flex flex-col gap-2.5">
          <Divider />
          <div className="flex items-center justify-between gap-3">
            <FieldLabel>Options</FieldLabel>
            <Button size="sm" variant="ghost" onClick={addOption}>
              <Plus size={13} aria-hidden /> Add Option
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
            <p className="max-w-prose text-meta text-text-secondary">
              No parameters yet. Add an option to accept arguments from the person running the
              command.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Divider />
        <div className="flex items-center justify-end gap-2.5">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} loading={saving} onClick={() => void submit()}>
            {saving ? 'Saving…' : editingCommand ? 'Update Command' : 'Create Command'}
          </Button>
        </div>
      </div>
    </Raised>
  );
}
