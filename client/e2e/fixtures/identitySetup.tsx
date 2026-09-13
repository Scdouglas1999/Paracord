import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AccountSetupPage } from '../../src/pages/AccountSetupPage';
import { useAuthStore } from '../../src/stores/authStore';
import { useServerListStore } from '../../src/stores/serverListStore';
import { setAccessToken } from '../../src/lib/authToken';
import '../../src/styles/globals.css';

export function renderIdentitySetup() {
  setAccessToken('fixture-token');
  useAuthStore.setState({ token: 'fixture-token', user: { id: '42', username: 'alice', discriminator: 0, bot: false, system: false, flags: 0, created_at: '' } });
  useServerListStore.setState({ activeServerId: '__local__', servers: [] });
  const node = document.createElement('div'); node.id = 'root'; document.body.append(node);
  createRoot(node).render(<MemoryRouter initialEntries={['/setup?migrate=1&server=__local__&user=42&returnTo=%2Fapp%2Fdm%2F100']}>
    <Routes><Route path="/setup" element={<AccountSetupPage />} /><Route path="/app/dm/100" element={<p>Returned to the conversation</p>} /></Routes>
  </MemoryRouter>);
}
