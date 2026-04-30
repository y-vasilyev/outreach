import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { useAuth } from './lib/auth';
import { LoginPage } from './features/auth/LoginPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { TgAccountsPage } from './features/tg-accounts/TgAccountsPage';
import { IntegrationsPage } from './features/integrations/IntegrationsPage';
import { EndpointsPage } from './features/endpoints/EndpointsPage';
import { AgentsPage } from './features/agents/AgentsPage';
import { AgentDetailPage } from './features/agents/AgentDetailPage';
import { ChannelsPage } from './features/channels/ChannelsPage';
import { ContactsPage } from './features/contacts/ContactsPage';
import { CampaignsPage } from './features/campaigns/CampaignsPage';
import { CampaignDetailPage } from './features/campaigns/CampaignDetailPage';
import { InboxPage } from './features/inbox/InboxPage';
import { ManualOutreachPage } from './features/manual/ManualOutreachPage';
import { UsersPage } from './features/users/UsersPage';
import { AuditPage } from './features/audit/AuditPage';
import { Spinner } from './components/Spinner';
import type { ReactNode } from 'react';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isReady } = useAuth();
  if (!isReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-brand-500" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="tg-accounts" element={<TgAccountsPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="endpoints" element={<EndpointsPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:id" element={<AgentDetailPage />} />
        <Route path="channels" element={<ChannelsPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="inbox/:conversationId" element={<InboxPage />} />
        <Route path="manual" element={<ManualOutreachPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
