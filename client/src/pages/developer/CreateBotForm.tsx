import { Button } from '../../components/ui/Button';

interface CreateBotFormProps {
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCreate: () => void;
}

export function CreateBotForm({ name, description, onNameChange, onDescriptionChange, onCreate }: CreateBotFormProps) {
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
        Create Bot Application
      </h2>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <label htmlFor="new-bot-name" className="sr-only">
          Bot name
        </label>
        <input
          id="new-bot-name"
          className="input-field"
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
        <input
          id="new-bot-description"
          className="input-field"
          placeholder="Description (optional)"
          value={description}
          maxLength={400}
          onChange={(e) => onDescriptionChange(e.target.value)}
        />
        <Button
          className="h-[2.9rem] min-w-[7rem]"
          onClick={onCreate}
        >
          Create
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        A bot user account will be created automatically. The token is shown only once on creation -- copy it immediately.
      </p>
    </div>
  );
}
