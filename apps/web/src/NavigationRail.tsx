import styles from "./NavigationRail.module.css";
export type WorkspaceSection = "work" | "repositories" | "tickets" | "account";
const sections = [
  { id: "work", label: "Work", path: "M3 10 10 4l7 6M5 9v9h4v-5h2v5h4V9" },
  {
    id: "repositories",
    label: "Repositories",
    path: "M5 3h11v14H6a2 2 0 0 1 0-4h10M5 3v12M8 6h5M8 9h5",
  },
  {
    id: "tickets",
    label: "Tickets",
    path: "M3 5h14v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V5Zm7 2v2m0 3v3",
  },
  {
    id: "account",
    label: "Account",
    path: "M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM3 18v-2c0-3 14-3 14 0v2",
  },
] as const;
export function NavigationRail({
  section,
  onSelect,
}: {
  section: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
}) {
  return (
    <nav className={styles.rail} aria-label="Workspace">
      {sections.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`${styles.item} ${item.id === "account" ? styles.account : ""}`}
          aria-label={item.label}
          title={item.label}
          aria-current={section === item.id ? "page" : undefined}
          onClick={() => onSelect(item.id)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d={item.path} />
          </svg>
        </button>
      ))}
    </nav>
  );
}
export function WorkspacePlaceholder({ section }: { section: Exclude<WorkspaceSection, "work"> }) {
  const label = sections.find((item) => item.id === section)!.label;
  return (
    <div className={styles.placeholder}>
      <aside className={styles.context} aria-label={`${label} sidebar`}>
        <h2>{label}</h2>
      </aside>
      <main id="workspace-content" className={styles.placeholderMain} tabIndex={-1}>
        <header>
          <h1>{label}</h1>
        </header>
        <p className={styles.placeholderText}>Coming soon</p>
      </main>
    </div>
  );
}
