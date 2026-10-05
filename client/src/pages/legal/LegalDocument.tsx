import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import { Divider } from '../../components/ui/Divider';
import { PEOPLE_HUE } from '../../lib/identityHue';

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
 * Long-form legal prose on the ground with the main glow at hue 210, the entry
 * pages' look (docs/index-spec.md §6.14): no card, a comfortable reading measure,
 * a 28/700 title, 17/700 section headings, 14.5 body in the secondary ink and a
 * hairline between sections. Not a marketing page, not a stack of cards.
 */
export function LegalDocument({ eyebrow, icon: Icon, title, updated, intro, sections }: LegalDocumentProps) {
  return (
    // `html, body, #root` are `overflow: hidden` (tokens.css): nothing in this
    // app scrolls the document, every scroll belongs to a named region. A
    // `min-h-dvh` page inside that is not a long page — it is a clipped one,
    // and these documents run to ~2100px, so everything past the first screen
    // was unreachable. The region owns its own scrolling, and takes focus so a
    // keyboard can drive it with Page Down / Home / End.
    <div
      role="region"
      aria-label={title}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this viewport with Page Up/Down and Home/End.
      tabIndex={0}
      className="ix-auth ix-hue-main ix-lt--main h-dvh overflow-y-auto"
      style={{ '--ix-hue': PEOPLE_HUE } as CSSProperties}
    >
      <div className="mx-auto w-full max-w-[860px] px-4 py-8 sm:px-8 sm:py-12">
        <Link
          to="/register"
          className="pc-focusable ix-auth__link mb-8 inline-flex h-9 items-center gap-2 rounded-[10px]"
        >
          <ArrowLeft size={16} aria-hidden />
          Back to registration
        </Link>

        <div>
          <header>
            <div className="inline-flex items-center gap-2 text-[12.5px] font-semibold text-[var(--ix-ink-3)]">
              <Icon size={15} aria-hidden />
              {eyebrow}
            </div>
            <h1 className="ix-auth__title mt-3">{title}</h1>
            <p className="mt-3 max-w-prose text-[14.5px] leading-[1.5] text-[var(--ix-ink-3)]">{intro}</p>
            <p className="mt-4 text-[12.5px] tabular-nums text-[var(--ix-ink-3)]">Last updated {updated}</p>
          </header>

          <div className="mt-10 gap-12 lg:flex">
            {/* Table of contents */}
            <nav aria-label="On this page" className="mb-8 shrink-0 lg:mb-0 lg:w-52">
              <div className="lg:sticky lg:top-8">
                <p className="mb-2 text-[12.5px] font-semibold text-[var(--ix-ink-3)]">On this page</p>
                <ul className="flex flex-col">
                  {sections.map((s) => (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        className="pc-focusable block rounded-[8px] py-1 text-[13.5px] font-medium text-[var(--ix-ink-2)] transition-colors duration-[40ms] ease-[var(--ix-ease)] hover:text-[var(--ix-ink)]"
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
                  <h2 className="ix-auth__step">{s.heading}</h2>
                  <div className="mt-3 flex flex-col gap-4">
                    {s.body.map((para, i) => (
                      <p key={i} className="text-[14.5px] leading-[1.55] text-[var(--ix-ink-2)]">
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
