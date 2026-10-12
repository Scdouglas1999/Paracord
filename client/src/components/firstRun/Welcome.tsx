import { CordMark } from '../brand/CordMark';
import { Avatar } from '../ix/identity/Avatar';
import { ServerMark } from '../ix/identity/ServerMark';
import type { FirstRunPath } from '../../stores/firstRunStore';
import { FrGlyph } from './primitives';

/**
 * The welcome (the approved prototype, which supersedes spec §1.3's two cards):
 * the window split down the middle, Host on the left and Join on the right,
 * both at once with a small picture of what each is. Hovering one side lights
 * it and dims the other; choosing a side opens it to the full window (the
 * `data-chose` styles), then the steps begin.
 *
 * Each half is a picture plus one button that covers it, so the whole half is
 * the target while the headings and lists stay outside the button.
 *
 * The vignettes are illustrations, not data: "Your server" and an example
 * friend's server.
 */
export function Welcome({
  chose,
  showHost,
  showMark,
  onChoose,
  onSignIn,
}: {
  chose: FirstRunPath | null;
  /** Hosting is offered only in the desktop app (§1.3). */
  showHost: boolean;
  /** The welcome mark (hidden while the launch's mark glides onto it). */
  showMark: boolean;
  onChoose: (path: FirstRunPath) => void;
  onSignIn: () => void;
}) {
  return (
    <section className="fr-wel" data-chose={chose ?? undefined} aria-labelledby="fr-welcome-title">
      <div className="fr-halves">
        {showHost && (
          <div className="fr-half fr-half--host">
            <span className="fr-half__glow" />
            <div className="fr-hin">
              <div className="fr-vig" aria-hidden="true">
                <span className="fr-vcard" style={{ left: 0, top: 4 }}>
                  <ServerMark guildId="0" name="F" hue={22} size={40} />
                  <span>
                    <b>Your server</b>
                    <small>
                      <i />
                      Online · on this computer
                    </small>
                  </span>
                </span>
                <span className="fr-vchips" style={{ left: 26, top: 76 }}>
                  {['Encrypted', 'Backed up', 'Friends can join'].map((label) => (
                    <span key={label} className="fr-vchip">
                      <FrGlyph name="check" size={13} strokeWidth={2.4} />
                      {label}
                    </span>
                  ))}
                </span>
              </div>
              <span className="fr-eyebrow">Start something new</span>
              <h2>Host a server</h2>
              <ul className="fr-facts">
                <li>Runs on this computer, even with the window closed</li>
                <li>Ready in about a minute; we do the setup</li>
                <li>Encrypted and backed up from the start</li>
              </ul>
              <span className="fr-cta" aria-hidden="true">
                Host a server
                <FrGlyph name="arrow" size={16} strokeWidth={2.1} />
              </span>
            </div>
            <button type="button" className="fr-half__hit" onClick={() => onChoose('host')} aria-label="Host a server" data-testid="fr-choose-host" />
          </div>
        )}
        <div className="fr-half fr-half--join">
          <span className="fr-half__glow" />
          <div className="fr-hin">
            <div className="fr-vig" aria-hidden="true">
              <span className="fr-vlink" style={{ left: 0, top: 0 }}>
                <FrGlyph name="link" size={15} />
                kanto.home.arpa/invite/Rf8kQ2
              </span>
              <span className="fr-vcard" style={{ left: 40, top: 50 }}>
                <ServerMark guildId="0" name="K" hue={200} size={40} />
                <span>
                  <b>Kanto Friends</b>
                  <small>
                    <i />9 online
                  </small>
                </span>
                <span className="fr-faces">
                  <Avatar userId="m" name="M" hue={18} size={26} />
                  <Avatar userId="t" name="T" hue={150} size={26} />
                  <Avatar userId="j" name="J" hue={220} size={26} />
                </span>
              </span>
            </div>
            <span className="fr-eyebrow">Got an invite?</span>
            <h2>Join friends</h2>
            <ul className="fr-facts">
              <li>Paste the link a friend sent you</li>
              <li>See who&rsquo;s there before you join</li>
              <li>Talking in a few seconds, privately</li>
            </ul>
            <span className="fr-cta" aria-hidden="true">
              Join with an invite
              <FrGlyph name="arrow" size={16} strokeWidth={2.1} />
            </span>
          </div>
          <button type="button" className="fr-half__hit" onClick={() => onChoose('join')} aria-label="Join with an invite" data-testid="fr-choose-join" />
        </div>
      </div>
      {showHost && <div className="fr-seam" aria-hidden="true" />}
      <div className="fr-whead">
        <div className="fr-whead__mark">{showMark && <CordMark size={96} />}</div>
        <h1 id="fr-welcome-title">Welcome to Paracord</h1>
        <p>A place to talk with your people, on a server you or a friend runs. Private by default.</p>
      </div>
      <div className="fr-wfoot">
        Already have an account?
        <button type="button" onClick={onSignIn}>
          Sign in
        </button>
      </div>
    </section>
  );
}
