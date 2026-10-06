const overview = [
  { label: "Accounts", value: "—", detail: "Connect your workspace" },
  { label: "Automation jobs", value: "—", detail: "No jobs created yet" },
  { label: "Browser workers", value: "0", detail: "Ready when you are" },
];

export default function Home() {
  return (
    <div className="dashboard">
      <section className="welcome" aria-labelledby="welcome-title">
        <p className="eyebrow">WORKSPACE OVERVIEW</p>
        <h2 id="welcome-title">Your automation workspace</h2>
        <p className="welcome-copy">
          Organize your browser workflows, prepare tasks, and follow each run from one place.
        </p>
      </section>

      <section className="overview-grid" aria-label="Workspace summary">
        {overview.map((item) => (
          <article className="summary-card" key={item.label}>
            <p className="card-label">{item.label}</p>
            <p className="card-value">{item.value}</p>
            <p className="card-detail">{item.detail}</p>
          </article>
        ))}
      </section>

      <section className="getting-started" aria-labelledby="getting-started-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">FIRST STEPS</p>
            <h2 id="getting-started-title">Build your workspace</h2>
          </div>
          <span className="step-badge">Step 01 of 55</span>
        </div>
        <div className="starter-row">
          <span className="starter-icon" aria-hidden="true">01</span>
          <div>
            <h3>Project foundation</h3>
            <p>The app shell is ready. Account and automation modules will be added incrementally.</p>
          </div>
          <span className="starter-status">Foundation</span>
        </div>
      </section>

      <footer className="dashboard-footer">
        <span>KartStudio</span>
        <span>Built for deliberate, observable automation.</span>
      </footer>
    </div>
  );
}
