import { useNavigate } from 'react-router-dom';
import { TopBar } from '../../components/layout/TopBar';
import { LoadingSpinner } from '../../components/ui/Feedback';

export function GuildLoadingScreen() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar channelName="Loading..." />
      <div className="flex flex-1 items-center justify-center">
        <LoadingSpinner label="Loading channels..." />
      </div>
    </div>
  );
}

export function ChannelNotFoundScreen({ guildId }: { guildId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar channelName="Channel not found" />
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="settings-surface-card w-full max-w-md text-center">
          <h2 className="mb-3 text-xl font-semibold text-text-primary">Channel not found</h2>
          <p className="mb-6 text-sm leading-6 text-text-muted">
            This channel may have been deleted or you may not have access to it.
          </p>
          {guildId && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => navigate(`/app/guilds/${guildId}`)}
            >
              Back to Server
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
