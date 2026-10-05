import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { SettingsSectionHeader } from '../../components/ui/SettingsShell';

interface CreateBotFormProps {
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCreate: () => void;
}

export function CreateBotForm({ name, description, onNameChange, onDescriptionChange, onCreate }: CreateBotFormProps) {
  return (
    // A heading and two fields on the page itself, so no box of its own.
    <section>
      <SettingsSectionHeader
        title="Create an application"
        description="A bot user is created automatically. The token is shown once on creation — copy it right away."
      />
      {/* Visible labels, like every other settings form: an `sr-only` label with
          a placeholder standing in for it disappears the moment somebody starts
          typing, and this form has two fields that are easy to confuse. */}
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <TextField
          id="new-bot-name"
          label="Bot name"
          placeholder="Thermal watcher"
          value={name}
          maxLength={80}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
        <TextField
          id="new-bot-description"
          label="Description"
          placeholder="What it does, in one line (optional)"
          value={description}
          maxLength={400}
          onChange={(e) => onDescriptionChange(e.target.value)}
        />
        <Button size="lg" onClick={onCreate} className="gap-2 sm:min-w-[8rem]">
          <Plus size={16} />
          Create
        </Button>
      </div>
    </section>
  );
}
