import { Icon } from "./icons";
import styles from "./NavigationRail.module.css";
import { Avatar } from "./Avatar";
import type { AuthUser } from "./auth-api";
export type WorkspaceSection = "work" | "repositories" | "tickets" | "account";
const sections = [
  { id: "work", label: "Work", icon: "work" },
  { id: "repositories", label: "Repositories", icon: "repository" },
  { id: "tickets", label: "Tickets", icon: "tickets" },
  { id: "account", label: "Profile", icon: "account" },
] as const;
export function NavigationRail({
  section,
  onSelect,
  viewer,
}: {
  section: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
  viewer?: AuthUser;
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
          {item.id === "account" && viewer ?
            <Avatar name={viewer.username || viewer.name} image={viewer.image}
              className={styles.avatar} fallback="icon" /> :
            <Icon kind={item.icon} />}
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
