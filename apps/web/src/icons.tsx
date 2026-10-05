import {
  IconHome,
  IconFolder,
  IconFolderOpen,
  IconTicket,
  IconUser,
  IconBell,
  IconPin,
  IconSearch,
  IconClock,
  IconLoader2,
  IconHelpCircle,
  IconCheck,
  IconAlertCircle,
  IconPlayerStop,
  IconPlus,
  IconX,
  IconDots,
  IconArchive,
  IconArchiveOff,
  IconArrowUp,
  IconFileText,
} from "@tabler/icons-react";
const icons = {
  work: IconHome,
  repository: IconFolder,
  folderOpen: IconFolderOpen,
  tickets: IconTicket,
  account: IconUser,
  bell: IconBell,
  pin: IconPin,
  search: IconSearch,
  queued: IconClock,
  working: IconLoader2,
  input: IconHelpCircle,
  review: IconHelpCircle,
  completed: IconCheck,
  failed: IconAlertCircle,
  stopped: IconPlayerStop,
  plus: IconPlus,
  close: IconX,
  more: IconDots,
  archive: IconArchive,
  restore: IconArchiveOff,
  send: IconArrowUp,
  file: IconFileText,
} as const;
export type IconKind = keyof typeof icons;
export function Icon({ kind }: { kind: IconKind }) {
  const Component = icons[kind];
  return (
    <Component
      size={20}
      stroke={1.5}
      aria-hidden="true"
      focusable="false"
      className={kind === "working" ? "working-spinner" : undefined}
    />
  );
}
