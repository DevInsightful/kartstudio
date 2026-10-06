export default function Loading() {
  return (
    <div className="loading-state" role="status" aria-label="Loading page">
      <span className="loading-spinner" />
      <span>Loading workspace…</span>
    </div>
  );
}
