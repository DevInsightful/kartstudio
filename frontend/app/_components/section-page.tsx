export function SectionPage({
  eyebrow,
  description,
  emptyTitle,
  emptyMessage,
}: {
  eyebrow: string;
  description: string;
  emptyTitle: string;
  emptyMessage: string;
}) {
  return (
    <div className="section-page">
      <section className="section-intro">
        <p className="eyebrow">{eyebrow}</p>
        <p>{description}</p>
      </section>
      <section className="empty-state" aria-label={`${eyebrow} empty state`}>
        <span className="empty-state-mark" aria-hidden="true">+</span>
        <h2>{emptyTitle}</h2>
        <p>{emptyMessage}</p>
        <span className="coming-soon-pill">Module placeholder</span>
      </section>
    </div>
  );
}
