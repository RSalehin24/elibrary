import AppShell from "./layouts/AppShell";
import AppRoutes from "./features/app/AppRoutes";
import BackendStatusModal from "./features/app/BackendStatusModal";
import RouteScrollReset from "./features/app/RouteScrollReset";
import SessionRestartHandler from "./features/app/SessionRestartHandler";

export default function App() {
  return (
    <AppShell>
      <RouteScrollReset />
      <SessionRestartHandler />
      <BackendStatusModal />
      <AppRoutes />
    </AppShell>
  );
}
