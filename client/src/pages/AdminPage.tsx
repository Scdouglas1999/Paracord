import { useCallback, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { isAdmin } from '../types';
import { LoadingSpinner } from '../components/ui';
import { EmptyPage, LargeTitlePage } from '../components/ix/page';
import { CreamButton } from '../components/ix/primitives';
import { Segmented, segmentedIds } from '../components/ix/people/Segmented';
import { usePushedPageKeys } from '../components/rooms/lobby/usePushedPageKeys';
import { PEOPLE_HUE } from '../lib/identityHue';
import { OverviewPanel } from './admin/OverviewPanel';
import { UsersPanel } from './admin/UsersPanel';
import { GuildsPanel } from './admin/GuildsPanel';
import { SettingsPanel } from './admin/SettingsPanel';
import { FederationPanel } from './admin/FederationPanel';
import { SecurityPanel } from './admin/SecurityPanel';
import { BackupsPanel } from './admin/BackupsPanel';
import { AddonsPanel } from './admin/AddonsPanel';

type Tab = 'overview' | 'users' | 'guilds' | 'settings' | 'federation' | 'security' | 'backups' | 'addons';

/**
 * The control plane is a page in main (docs/index-spec.md §6.1, §8.1): the large
 * title "Admin", and under it a segmented control for its sections, with the
 * section's panel below. Every tab id, the admin gate and the route are unchanged.
 * It is reached from the account menu; Esc and the toolbar's back chevron go back
 * to the place you came from (`/app` opens the last place).
 */
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'users', label: 'Users' },
  { value: 'guilds', label: 'Servers' },
  { value: 'federation', label: 'Federation' },
  { value: 'settings', label: 'Settings' },
  { value: 'addons', label: 'Add-ons' },
  { value: 'security', label: 'Security' },
  { value: 'backups', label: 'Backups' },
];

const PAGE_CLASS = 'ix-sp ix-lt--main ix-adm';
const SUBTITLE = 'Instance administration';

export function AdminPage() {
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  // `/app` is not a page any more: it opens the place you were in.
  const goBack = useCallback(() => navigate('/app'), [navigate]);
  usePushedPageKeys(goBack);

  const hue = { '--ix-hue': PEOPLE_HUE } as CSSProperties;

  if (!currentUser) {
    return (
      <div className="ix-hued" style={hue}>
        <LargeTitlePage title="Admin" subtitle={SUBTITLE} onBack={goBack} className={PAGE_CLASS} data-testid="ix-admin">
          <LoadingSpinner size="sm" label="Checking admin access..." className="justify-start" />
        </LargeTitlePage>
      </div>
    );
  }

  if (!isAdmin(currentUser.flags ?? 0)) {
    return (
      <div className="ix-hued" style={hue}>
        <LargeTitlePage title="Admin" subtitle={SUBTITLE} onBack={goBack} className={PAGE_CLASS} data-testid="ix-admin">
          <EmptyPage
            inline
            role="alert"
            glyph="lock"
            title="Access denied"
            line="The control plane is limited to instance administrators. Ask an admin to grant you access, then come back."
            action={<CreamButton onClick={goBack}>Back</CreamButton>}
          />
        </LargeTitlePage>
      </div>
    );
  }

  const ids = segmentedIds('admin-section', activeTab);

  return (
    <div className="ix-hued" style={hue}>
      <LargeTitlePage title="Admin" subtitle={SUBTITLE} onBack={goBack} className={PAGE_CLASS} data-testid="ix-admin">
        <div className="ix-adm__bar">
          <div className="ix-adm__tabs">
            <Segmented
              label="Administration sections"
              idBase="admin-section"
              items={TABS}
              value={activeTab}
              onChange={setActiveTab}
            />
          </div>
        </div>
        <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className="ix-adm__panel">
          {activeTab === 'overview' && <OverviewPanel />}
          {activeTab === 'users' && <UsersPanel />}
          {activeTab === 'guilds' && <GuildsPanel />}
          {activeTab === 'settings' && <SettingsPanel />}
          {activeTab === 'federation' && <FederationPanel />}
          {activeTab === 'security' && <SecurityPanel />}
          {activeTab === 'backups' && <BackupsPanel />}
          {activeTab === 'addons' && <AddonsPanel />}
        </div>
      </LargeTitlePage>
    </div>
  );
}
