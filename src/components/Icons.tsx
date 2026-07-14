import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "media" | "analysis" | "effects" | "captions" | "transitions" | "inspector" | "chat"
  | "play" | "pause" | "split" | "trash" | "undo" | "redo" | "save"
  | "export" | "open" | "plus" | "search" | "lock" | "eye" | "volume" | "settings"
  | "stop" | "send" | "transcript" | "video" | "audio" | "close";

const paths: Record<IconName, ReactNode> = {
  media: <><rect x="3" y="5" width="18" height="14"/><path d="m9 9 6 3-6 3Z"/></>,
  analysis: <><path d="M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4Z"/><path d="m14 17 2 2 4-5"/></>,
  effects: <><path d="M4 17 17 4"/><path d="m14 4 3 3"/><path d="M4 7h4M6 5v4M15 15h5M17.5 12.5v5"/></>,
  captions: <><rect x="3" y="5" width="18" height="14"/><path d="M7 10h4M7 14h3M14 10h3M13 14h4"/></>,
  transitions: <><path d="M3 6h8l-3 6 3 6H3l3-6Z"/><path d="M21 6h-8l3 6-3 6h8l-3-6Z"/></>,
  inspector: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="18" r="2"/></>,
  chat: <><path d="M4 4h16v12H9l-5 4Z"/><path d="M8 9h8M8 12h5"/></>,
  play: <path d="m8 5 11 7-11 7Z"/>, pause: <><path d="M8 5v14M16 5v14"/></>,
  split: <><path d="M12 3v18"/><circle cx="6" cy="8" r="3"/><circle cx="18" cy="16" r="3"/><path d="m9 9 6 5M9 15l6-5"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>,
  undo: <><path d="m9 7-5 5 5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></>,
  redo: <><path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></>,
  save: <><path d="M5 3h12l3 3v15H4V3Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></>,
  export: <><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v8h14v-8"/></>,
  open: <><path d="M3 6h7l2 3h9l-2 11H4Z"/><path d="M3 6v14M12 9l-2 4"/></>,
  plus: <path d="M12 4v16M4 12h16"/>,
  search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
  lock: <><rect x="5" y="10" width="14" height="11"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  eye: <><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
  volume: <><path d="M4 10h4l5-4v12l-5-4H4Z"/><path d="M17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></>,
  stop: <rect x="6" y="6" width="12" height="12"/>,
  send: <><path d="m3 4 18 8-18 8 4-8Z"/><path d="M7 12h14"/></>,
  transcript: <><path d="M5 3h14v18H5Z"/><path d="M8 8h8M8 12h8M8 16h5"/></>,
  video: <><rect x="3" y="6" width="13" height="12"/><path d="m16 10 5-3v10l-5-3Z"/></>,
  audio: <><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></>,
  close: <path d="M5 5l14 14M19 5 5 19"/>,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
