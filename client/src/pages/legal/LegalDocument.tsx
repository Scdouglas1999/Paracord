import { Link } from 'react-router';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import { Divider } from '../../components/ui/Divider';

export interface LegalSection {
  id: string;
  heading: string;
  body: string[];
}

interface LegalDocumentProps {
  eyebrow: string;
  icon: LucideIcon;
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}

/**
 * Long-form legal prose on one plate, centred on the street
 * (docs/lantern-stage-spec.md §2, §4): a comfortable reading measure, Gabarito
 * headings, Onest body, a mono "last updated" stamp, and a hairline between
 * sections. Not a marketing page, not a stack of cards.
 */
export function LegalDocument({ eyebrow, icon: Icon, title, updated, intro, sections }: LegalDocumentProps) {
  return (
    <div className="min-h-dvh bg-bg-base">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <Link
          to="/register"
          className="pc-focusable mb-6 inline-flex h-[var(--h-control)] items-center gap-2 rounded-[var(--radius-control)] text-label font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:text-text-primary"
        >
          <ArrowLeft size={16} aria-hidden />
          Back to registration
        </Link>

        <div className="pc-plate p-7 sm:p-9">
          <header>
            <div className="inline-flex items-center gap-2 text-section text-accent-primary">
              <Icon size={15} aria-hidden />
              {eyebrow}
            </div>
            <h1 className="mt-3 pc-display text-display text-text-primary">{title}</h1>
            <p className="mt-3 max-w-prose text-body text-text-secondary">{intro}</p>
            <p className="mt-4 pc-mono text-meta text-text-faint">Last updated {updated}</p>
          </header>

          <div className="mt-8 gap-10 lg:flex">
            {/* Table of contents */}
            <nav aria-label="On this page" className="mb-8 shrink-0 lg:mb-0 lg:w-52">
              <div className="lg:sticky lg:top-8">
                <p className="mb-2 text-section text-text-faint">On this page</p>
                <ul className="flex flex-col">
                  {sections.map((s) => (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        className="pc-focusable block rounded-[var(--radius-chip)] py-1 text-label text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:text-accent-primary"
                      >
                        {s.heading}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>

            {/* Prose */}
            <article className="min-w-0 max-w-prose flex-1">
              {sections.map((s, index) => (
                <section key={s.id} id={s.id} className="scroll-mt-8">
                  {index > 0 && <Divider className="my-8" />}
                  <h2 className="pc-display text-heading text-text-primary">{s.heading}</h2>
                  <div className="mt-3 flex flex-col gap-4">
                    {s.body.map((para, i) => (
                      <p key={i} className="text-body text-text-secondary">
                        {para}
                      </p>
                    ))}
                  </div>
                </section>
              ))}
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}
