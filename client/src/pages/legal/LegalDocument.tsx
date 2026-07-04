import { Link } from 'react-router-dom';
import { ArrowLeft, type LucideIcon } from 'lucide-react';

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

// Long-form legal prose (design-spec §2): readable measure, Fraunces headings,
// Body prose in --text-secondary, section anchors + a table of contents. Not a
// card, not a sparse marketing page.
export function LegalDocument({ eyebrow, icon: Icon, title, updated, intro, sections }: LegalDocumentProps) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
        <Link
          to="/register"
          className="mb-10 inline-flex items-center gap-2 rounded-sm text-label font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
        >
          <ArrowLeft size={16} />
          Back to registration
        </Link>

        <header className="border-b border-border-subtle pb-8">
          <div className="mb-4 inline-flex items-center gap-2 text-section uppercase text-accent-primary">
            <Icon size={15} />
            {eyebrow}
          </div>
          <h1 className="font-display text-display text-text-primary">{title}</h1>
          <p className="mt-3 max-w-[60ch] text-body text-text-secondary">{intro}</p>
          <p className="mt-4 font-code text-meta text-text-muted">Last updated {updated}</p>
        </header>

        <div className="mt-10 gap-12 lg:flex">
          {/* Table of contents */}
          <nav aria-label="On this page" className="mb-8 shrink-0 lg:mb-0 lg:w-56">
            <div className="lg:sticky lg:top-10">
              <p className="mb-3 text-section uppercase text-text-muted">On this page</p>
              <ul className="space-y-1.5">
                {sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="block rounded-sm py-0.5 text-label text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-accent-primary focus-visible:shadow-[var(--focus-ring)]"
                    >
                      {s.heading}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          {/* Prose */}
          <article className="min-w-0 max-w-[68ch] flex-1 space-y-10">
            {sections.map((s) => (
              <section key={s.id} id={s.id} className="scroll-mt-10">
                <h2 className="font-display text-heading text-text-primary">{s.heading}</h2>
                <div className="mt-3 space-y-4">
                  {s.body.map((para, i) => (
                    <p key={i} className="text-body leading-relaxed text-text-secondary">
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
  );
}
