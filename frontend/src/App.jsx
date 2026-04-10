import AppShell from "./layouts/AppShell";
import AppRoutes from "./features/app/AppRoutes";
import BackendStatusModal from "./features/app/BackendStatusModal";
import SessionRestartHandler from "./features/app/SessionRestartHandler";

export default function App() {
  return (
    <AppShell>
      <SessionRestartHandler />
      <BackendStatusModal />
      <AppRoutes />
    </AppShell>
  );
}
