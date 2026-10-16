import { Button } from '../components/ui/Button';
import { AUTH_FORM, AuthCanvas, AuthCard, AuthHeading } from './authScaffold';

/**
 * An account screen reached on the desktop before any server was chosen.
 *
 * Every account flow talks to the home server. With none saved (and this
 * computer hosting none, `lib/host/adoptHostedServer.ts`), the page says so
 * and sends the person to sign-in, where the server is chosen, instead of
 * sending a request that names no server and showing the refusal mid-form.
 */
export function ChooseServerFirst({ body, onSignIn, onBack }: { body: string; onSignIn: () => void; onBack: () => void }) {
  return (
    <AuthCanvas>
      <AuthCard>
        <div className={AUTH_FORM} data-testid="choose-server-first">
          <AuthHeading title="Choose your server first" subtitle={body} />
          <div className="flex items-center gap-3">
            <Button type="button" variant="ghost" size="lg" onClick={onBack}>
              Back
            </Button>
            <Button type="button" size="lg" className="flex-1" onClick={onSignIn}>
              Go to sign-in
            </Button>
          </div>
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
