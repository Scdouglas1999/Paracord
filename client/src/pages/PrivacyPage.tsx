import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

export function PrivacyPage() {
  return (
    <div className="legal-shell">
      <div className="legal-card">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-mod-subtle px-3 py-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              <ShieldCheck size={14} />
              Privacy
            </div>
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Privacy Policy</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">
              This deployment is self-hosted. Data processing and retention policies are controlled by the server operator.
            </p>
          </div>
          <Link
            to="/register"
            className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm font-semibold text-text-link transition-colors hover:bg-bg-mod-strong"
          >
            <ArrowLeft size={15} />
            Back to registration
          </Link>
        </div>

        <div className="space-y-3">
          {[
            'Account data includes username, email, profile metadata, and authentication records.',
            'Messages, attachments, and moderation events are stored to provide core functionality.',
            'Server operators can access operational logs and moderation data for abuse prevention.',
            'You may request account or data deletion from the server administrator.',
          ].map((item) => (
            <div key={item} className="rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm leading-6 text-text-secondary">
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
