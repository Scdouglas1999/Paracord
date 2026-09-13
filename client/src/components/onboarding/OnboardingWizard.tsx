import { useState } from 'react';
import { Server, Shield, Users, Globe, ArrowRight, ArrowLeft } from 'lucide-react';
import {
  getVersionedStorageItem,
  setVersionedStorageItem,
} from '../../lib/versionedStorage';
import { Button } from '../ui/Button';
import { Divider } from '../ui/Divider';
import { AuthCanvas, AuthCard } from '../../pages/authScaffold';

interface OnboardingWizardProps {
  onComplete: () => void;
  onTryDemo?: () => void;
}

interface FeatureRow {
  icon: typeof Server;
  title: string;
  body: string;
}

/**
 * A divided list of value props inside one well — not a stack of identical
 * bordered cards (spec §6.8), and not three icons in three different colours:
 * colour here would be decoration, and the only colours this app spends are
 * light (a person is there) and the emerald (an action you can take).
 */
function FeatureList({ rows }: { rows: FeatureRow[] }) {
  return (
    <div className="pc-well px-3.5 py-1">
      {rows.map((row, index) => {
        const Icon = row.icon;
        return (
          <div key={row.title}>
            {index > 0 && <Divider />}
            <div className="flex items-start gap-3 py-3">
              <Icon size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
              <div className="min-w-0">
                <div className="text-label text-text-primary">{row.title}</div>
                <div className="text-meta leading-relaxed text-text-faint">{row.body}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STEPS = [
  {
    title: 'Welcome to Paracord',
    subtitle: 'A self-hosted, decentralized place for your people',
    icon: Globe,
    content: (
      <div className="flex flex-col gap-4">
        <p className="text-body text-text-secondary">
          Unlike centralized platforms, Paracord gives you{' '}
          <strong className="font-semibold text-text-primary">full control</strong> over your
          conversations. Your data lives on servers that you or your community operate.
        </p>
        <FeatureList
          rows={[
            {
              icon: Server,
              title: 'Self-hosted',
              body: 'Your server, your rules, your data',
            },
            {
              icon: Shield,
              title: 'End-to-end encrypted',
              body: 'Optional E2EE for private direct messages',
            },
            {
              icon: Users,
              title: 'Multi-server',
              body: 'Connect to multiple communities seamlessly',
            },
          ]}
        />
      </div>
    ),
  },
  {
    title: 'Connect to a server',
    subtitle: 'You need a server to get started',
    icon: Server,
    content: (
      <div className="flex flex-col gap-4">
        <p className="text-body text-text-secondary">
          To use Paracord, you connect to a server hosted by you or someone you trust.
        </p>
        <div className="pc-well px-3.5 py-1">
          <div className="py-3">
            <div className="text-label text-text-primary">Join an existing server</div>
            <div className="mt-0.5 text-meta leading-relaxed text-text-faint">
              Ask your admin for a server address or invite link. It looks like{' '}
              <code className="rounded-[var(--radius-chip)] bg-bg-mod-strong px-1 py-0.5 pc-mono text-text-secondary">
                192.168.1.5:8090
              </code>{' '}
              or{' '}
              <code className="rounded-[var(--radius-chip)] bg-bg-mod-strong px-1 py-0.5 pc-mono text-text-secondary">
                paracord://invite/…
              </code>
            </div>
          </div>
          <Divider />
          <div className="py-3">
            <div className="text-label text-text-primary">Host your own server</div>
            <div className="mt-0.5 text-meta leading-relaxed text-text-faint">
              Download the server binary and run it on your machine, VPS, or home server. It takes
              a few minutes.
            </div>
          </div>
        </div>
        <p className="text-meta text-text-faint">
          You'll enter your server address on the next screen.
        </p>
      </div>
    ),
  },
];

const STORAGE_KEY = 'onboarding-complete';

export function hasCompletedOnboarding(): boolean {
  try {
    return getVersionedStorageItem(STORAGE_KEY, ['onboarding-complete']) === '1';
  } catch {
    return false;
  }
}

export function OnboardingWizard({ onComplete, onTryDemo }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  const Icon = current.icon;

  const handleComplete = () => {
    try {
      setVersionedStorageItem(STORAGE_KEY, '1');
    } catch {
      // localStorage unavailable
    }
    onComplete();
  };

  return (
    <AuthCanvas>
      <AuthCard className="max-w-lg">
        <div className="flex flex-col gap-6 p-7 sm:p-8">
          {/* Step indicator — the count is in the DOM as words too, so the bars
              are never the only cue (spec §9). */}
          <div
            className="flex items-center gap-2"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={step + 1}
            aria-label={`Step ${step + 1} of ${STEPS.length}`}
          >
            {STEPS.map((_, i) => (
              <span
                key={i}
                aria-hidden
                className={`h-1.5 rounded-[var(--radius-full)] transition-all duration-[var(--duration-normal)] ease-[var(--ease-out)] ${
                  i <= step ? 'bg-accent-primary' : 'bg-bg-mod-strong'
                }`}
                style={{ width: i === step ? 26 : 8 }}
              />
            ))}
            <span className="ml-1 pc-mono text-meta text-text-faint">
              {step + 1} of {STEPS.length}
            </span>
          </div>

          {/* Header */}
          <div>
            <div
              className="pc-well mb-4 flex h-12 w-12 items-center justify-center text-text-secondary"
              aria-hidden
            >
              <Icon size={24} />
            </div>
            <h1 className="pc-display text-title text-text-primary">{current.title}</h1>
            <p className="mt-1.5 text-body text-text-secondary">{current.subtitle}</p>
          </div>

          {/* Content */}
          <div className="flex flex-col gap-4">
            <div>{current.content}</div>
            {step === 1 && onTryDemo && (
              <Button type="button" variant="ghost" size="lg" onClick={onTryDemo} className="w-full">
                Try a public demo server
              </Button>
            )}
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-3">
            {step > 0 && (
              <Button variant="ghost" size="lg" onClick={() => setStep(step - 1)}>
                <ArrowLeft size={16} aria-hidden />
                Back
              </Button>
            )}
            <Button
              size="lg"
              className="flex-1"
              onClick={isLast ? handleComplete : () => setStep(step + 1)}
            >
              {isLast ? "Let's go" : 'Next'}
              {!isLast && <ArrowRight size={16} aria-hidden />}
            </Button>
          </div>

          {/* Skip option */}
          <button
            type="button"
            onClick={handleComplete}
            className="pc-focusable self-start rounded-[var(--radius-chip)] text-meta text-text-faint transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:text-text-secondary"
          >
            Skip introduction
          </button>
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
