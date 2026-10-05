import {
  IconHome,
  IconHomeFilled,
  IconFolderFilled,
  IconTicketFilled,
  IconUserFilled,
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
} as const;
const filledIcons = {
  work: IconHomeFilled,
  repository: IconFolderFilled,
  tickets: IconTicketFilled,
  account: IconUserFilled,
};
export type IconKind = keyof typeof icons;
export function Icon({ kind, filled = false }: { kind: IconKind; filled?: boolean }) {
  const Component =
    filled && kind in filledIcons ? filledIcons[kind as keyof typeof filledIcons] : icons[kind];
  return (
    <Component
      size={20}
      stroke={1.5}
      aria-hidden="true"
      focusable="false"
      data-filled={filled && kind in filledIcons ? "true" : undefined}
      className={kind === "working" ? "working-spinner" : undefined}
    />
  );
}
