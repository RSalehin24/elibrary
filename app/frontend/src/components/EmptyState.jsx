export default function EmptyState({ title, body }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
    </div>
  );
}
