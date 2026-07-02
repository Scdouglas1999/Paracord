import { Link } from 'react-router-dom';
import { ArrowLeft, ScrollText } from 'lucide-react';

export function TermsPage() {
  return (
    <div className="legal-shell">
      <div className="legal-card">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-mod-subtle px-3 py-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              <ScrollText size={14} />
              Legal
            </div>
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Terms of Service</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">
              These terms govern use of this Paracord deployment and outline the baseline responsibilities for users and operators.
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
            'You are responsible for activity performed with your account.',
            'Do not use the service for unlawful activity, abuse, harassment, or malware distribution.',
            'Server operators may moderate, suspend, or remove content that violates local rules.',
            'Availability is best-effort; backups and retention are managed by the server operator.',
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
