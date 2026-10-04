// One rounded outline family, drawn on the UI's existing 20-unit grid.
const paths = {
  work: "M3 9.5 8.7 4a1.8 1.8 0 0 1 2.6 0L17 9.5 M5 8v7.5A1.5 1.5 0 0 0 6.5 17H8v-4a2 2 0 0 1 4 0v4h1.5a1.5 1.5 0 0 0 1.5-1.5V8",
  repository:
    "M6 3h8a2 2 0 0 1 2 2v12H6a2.5 2.5 0 0 1-2.5-2.5v-9A2.5 2.5 0 0 1 6 3Z M3.5 14.5A2.5 2.5 0 0 1 6 12h10 M7 6h5M7 9h3",
  tickets:
    "M5 4h10a2 2 0 0 1 2 2v1.5a2.5 2.5 0 0 0 0 5V14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a2.5 2.5 0 0 0 0-5V6a2 2 0 0 1 2-2Z M10 6.5v1M10 9.5v1M10 12.5v1",
  account:
    "M13.5 6.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z M3.5 17v-1a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v1",
  bell: "M5.5 8a4.5 4.5 0 0 1 9 0v2.5c0 1 .5 1.7 1.4 2.6.5.5.2 1.4-.5 1.4H4.6c-.7 0-1-.9-.5-1.4.9-.9 1.4-1.6 1.4-2.6V8Z M8 17a2.5 2.5 0 0 0 4 0",
  pin: "M7 3h6 M8 3v3c0 1.4-.6 2.4-1.8 3.5-.5.4-.8 1-.8 1.7v.3h9.2v-.3c0-.7-.3-1.3-.8-1.7C12.6 8.4 12 7.4 12 6V3 M10 11.5V17",
  search: "M14 14l3 3 M15.5 9a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0",
  queued: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M10 6v4l3 2",
  working: "M17 10a7 7 0 1 1-7-7",
  input:
    "M6 3.5h8A3.5 3.5 0 0 1 17.5 7v3A3.5 3.5 0 0 1 14 13.5H8l-4 3v-3.6A3.5 3.5 0 0 1 2.5 10V7A3.5 3.5 0 0 1 6 3.5Z M8.5 7a1.5 1.5 0 0 1 3 0c0 1-1.5 1.2-1.5 2.5 M10 11v.1",
  review: "M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z M12.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
  completed: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M6.5 10l2.5 2.5 4.5-5",
  failed: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M10 6.5v4 M10 13v.1",
  stopped:
    "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M8 7h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z",
  plus: "M10 4v12M4 10h12",
  close: "m5 5 10 10M15 5 5 15",
  more: "M4 10h.1M10 10h.1M16 10h.1",
} as const;
export type IconKind = keyof typeof paths;
export function Icon({ kind }: { kind: IconKind }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={kind === "working" ? "working-spinner" : undefined}
    >
      <path d={paths[kind]} />
    </svg>
  );
}
