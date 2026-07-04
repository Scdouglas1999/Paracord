import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

interface CreateBotFormProps {
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCreate: () => void;
}

export function CreateBotForm({ name, description, onNameChange, onDescriptionChange, onCreate }: CreateBotFormProps) {
  return (
    <section className="rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
      <h2 className="font-display text-subhead text-text-primary">Create an application</h2>
      <p className="mt-1 text-body text-text-secondary">
        A bot user is created automatically. The token is shown once on creation — copy it right away.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
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
