import ExportActions from "../../components/ExportActions";

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 5.25v13.5M5.25 12h13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ManualBooksToolbarActions({
  composerOpen,
  downloadState,
  onExport,
  onToggleComposer
}) {
  return (
    <div className="manual-books-toolbar-actions">
      <ExportActions
        loading={downloadState}
        onExport={onExport}
        ariaLabel="Export manual books"
        bare
      />
      <div className="toolbar-action-panel toolbar-action-panel-compact is-bare">
        <button
          type="button"
          className={`toolbar-icon-button toolbar-icon-button-accent is-icon-only${
            composerOpen ? " is-active" : ""
          }`}
          onClick={onToggleComposer}
          aria-expanded={composerOpen}
          aria-controls="manual-book-composer"
          title={composerOpen ? "Close add book form" : "Add manual book"}
          aria-label={composerOpen ? "Close add book form" : "Add manual book"}
        >
          <span className="toolbar-icon-button-art">
            <PlusIcon />
          </span>
        </button>
      </div>
    </div>
  );
}
