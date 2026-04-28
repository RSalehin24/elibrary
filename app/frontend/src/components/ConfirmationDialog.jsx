import AsyncButton from "./AsyncButton";

export default function ConfirmationDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  loading = false
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="confirmation-dialog-title">
        <div className="dialog-header">
          <div>
            <h2 id="confirmation-dialog-title">{title}</h2>
          </div>
        </div>
        <p className="muted-copy">{body}</p>
        <div className="dialog-actions dialog-actions-end">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          <AsyncButton className="primary-button danger-button" onClick={onConfirm} loading={loading} loadingLabel="Deleting...">
            {confirmLabel}
          </AsyncButton>
        </div>
      </section>
    </div>
  );
}
