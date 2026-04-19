"use client";

/**
 * Inline SVG icons. Using SVGs rather than Unicode glyphs because some
 * WebView2 font stacks on Windows 10/11 don't ship glyphs for the fancier
 * symbol code points (pencil U+270E, multiplication X U+2715, etc.),
 * which silently renders empty or tofu boxes — making the buttons look
 * unclickable. SVG renders the same everywhere.
 */

type IconName =
  | "pencil"
  | "plus"
  | "folderPlus"
  | "trash"
  | "copy"
  | "chevronRight"
  | "chevronDown"
  | "gitBranch"
  | "more";

const PATHS: Record<IconName, string> = {
  pencil:
    "M12 20h9 M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z",
  plus:
    "M12 5v14 M5 12h14",
  folderPlus:
    "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z M12 11v6 M9 14h6",
  trash:
    "M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6",
  copy:
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M15 2H9a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z",
  chevronRight: "M9 18l6-6-6-6",
  chevronDown: "M6 9l6 6 6-6",
  gitBranch:
    "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M15 6a9 9 0 0 0-9 9",
  more: "M12 12h.01 M19 12h.01 M5 12h.01",
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 14, className, strokeWidth = 2 }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
