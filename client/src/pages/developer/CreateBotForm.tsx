import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
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
    // Inside the settings plate, so no box of its own (spec §4: never nest a
    // plate in a plate) — a heading and the fields, which are already wells.
    <section>
      <SettingsSectionHeader
        title="Create an application"
        description="A bot user is created automatically. The token is shown once on creation — copy it right away."
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <label htmlFor="new-bot-name" className="sr-only">
          Bot name
        </label>
        <Input
          id="new-bot-name"
          placeholder="Bot name"
          value={name}
          maxLength={80}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
        <label htmlFor="new-bot-description" className="sr-only">
          Description
        </label>
        <Input
          id="new-bot-description"
          placeholder="Description (optional)"
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
