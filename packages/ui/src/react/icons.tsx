// The interface's icons: one line set from iconmcp (16-unit grid, 1.5 stroke, round), drawn in the text's colour.
// Add one here, never inline an svg in a component. DESIGN.md section 7 lists what is needed.
// Each is decoration: a control that has only an icon must name itself (aria-label).
import type { ReactNode, SVGProps } from "react";

export type IconProps = { size?: number } & Omit<
  SVGProps<SVGSVGElement>,
  "children" | "width" | "height" | "viewBox" | "aria-hidden" | "focusable"
>;

function Svg({ size, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** iconmcp: square */
export const StopIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    </g>
  </Svg>
);

/** iconmcp: chevron-down */
export const ChevronDownIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g transform="rotate(90 8 8)">
      <path d="M5.875 3.75 L10.125 8 L5.875 12.25" />
    </g>
  </Svg>
);

/** iconmcp: server */
export const ServerIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="2.25" y="2.25" width="11.5" height="4.5" rx="1.2" />
      <rect x="2.25" y="9.25" width="11.5" height="4.5" rx="1.2" />
      <circle cx="5" cy="4.5" r="0.99" fill="currentColor" stroke="none" />
      <circle cx="5" cy="11.5" r="0.99" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: arrow-up */
export const SendIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g transform="rotate(-90 8 8)">
      <line x1="2.75" y1="8" x2="13.25" y2="8" />
      <path d="M8.5 3.25 L13.25 8 L8.5 12.75" />
    </g>
  </Svg>
);

/** iconmcp: plus */
export const PlusIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <line x1="8" y1="2.75" x2="8" y2="13.25" />
      <line x1="2.75" y1="8" x2="13.25" y2="8" />
    </g>
  </Svg>
);

/** iconmcp: more-horizontal */
export const MoreIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <circle cx="3.25" cy="8" r="0.99" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.99" fill="currentColor" stroke="none" />
      <circle cx="12.75" cy="8" r="0.99" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: edit */
export const RenameIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M10.957 3.457 L12.543 5.043 C12.933 5.433 12.933 6.067 12.543 6.457 L5.793 13.207 C5.605 13.395 5.351 13.5 5.086 13.5 L2.5 13.5 L2.5 10.914 C2.5 10.649 2.605 10.395 2.793 10.207 L9.543 3.457 C9.933 3.067 10.567 3.067 10.957 3.457 Z" />
      <line x1="8.75" y1="4.25" x2="11.75" y2="7.25" />
    </g>
  </Svg>
);

/** iconmcp: sliders */
export const SettingsIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <line x1="2.25" y1="4.75" x2="7.75" y2="4.75" />
      <circle cx="9.75" cy="4.75" r="2" />
      <line x1="11.75" y1="4.75" x2="13.75" y2="4.75" />
      <line x1="2.25" y1="11.25" x2="4.25" y2="11.25" />
      <circle cx="6.25" cy="11.25" r="2" />
      <line x1="8.25" y1="11.25" x2="13.75" y2="11.25" />
    </g>
  </Svg>
);

/** iconmcp: trash */
export const TrashIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M3.5 4.25 L4.105 11.907 C4.187 12.948 5.055 13.75 6.098 13.75 L9.902 13.75 C10.945 13.75 11.813 12.948 11.895 11.907 L12.5 4.25" />
      <line x1="2.25" y1="4.25" x2="13.75" y2="4.25" />
      <path d="M6 4.25 L6 3.25 C6 2.698 6.448 2.25 7 2.25 L9 2.25 C9.552 2.25 10 2.698 10 3.25 L10 4.25" />
      <line x1="6.75" y1="7" x2="6.75" y2="11" />
      <line x1="9.25" y1="7" x2="9.25" y2="11" />
    </g>
  </Svg>
);

/** iconmcp: archive */
export const ArchiveIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="1.75" y="2.75" width="12.5" height="3.5" rx="1" />
      <path d="M2.75 6.25 L2.75 11.25 C2.75 12.355 3.645 13.25 4.75 13.25 L11.25 13.25 C12.355 13.25 13.25 12.355 13.25 11.25 L13.25 6.25" />
      <line x1="6.5" y1="9" x2="9.5" y2="9" />
    </g>
  </Svg>
);

/** iconmcp: chevron-right */
export const ChevronRightIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M5.875 3.75 L10.125 8 L5.875 12.25" />
    </g>
  </Svg>
);

/** iconmcp: check */
export const CheckIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M2.75 8.5 L6.25 12 L13.25 4.5" />
    </g>
  </Svg>
);

/** iconmcp: close */
export const CloseIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <line x1="3.75" y1="3.75" x2="12.25" y2="12.25" />
      <line x1="12.25" y1="3.75" x2="3.75" y2="12.25" />
    </g>
  </Svg>
);

/** iconmcp: terminal */
export const TerminalIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.5 6 L6.5 8 L4.5 10" />
      <line x1="8" y1="10" x2="11" y2="10" />
    </g>
  </Svg>
);

/** iconmcp: search */
export const SearchIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <circle cx="7" cy="7" r="4.75" />
      <line x1="10.375" y1="10.375" x2="13.75" y2="13.75" />
    </g>
  </Svg>
);

/** iconmcp: alert */
export const WarningIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M9.311 4.36 L13.012 11.022 C13.567 12.021 12.844 13.25 11.701 13.25 L4.299 13.25 C3.156 13.25 2.433 12.021 2.988 11.022 L6.689 4.36 C7.26 3.332 8.74 3.332 9.311 4.36 Z" />
      <line x1="8" y1="6.25" x2="8" y2="8.75" />
      <circle cx="8" cy="10.9" r="0.99" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: browser */
export const WebIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <line x1="2.25" y1="7.25" x2="13.75" y2="7.25" />
      <circle cx="4.75" cy="5" r="0.99" fill="currentColor" stroke="none" />
      <line x1="7.5" y1="5" x2="11.25" y2="5" />
    </g>
  </Svg>
);

/** iconmcp: file-text */
export const FileReadIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M5.25 2 L9 2 L12.75 5.75 L12.75 12 C12.75 13.105 11.855 14 10.75 14 L5.25 14 C4.145 14 3.25 13.105 3.25 12 L3.25 4 C3.25 2.895 4.145 2 5.25 2 Z" />
      <path d="M9 2 L9 4.75 C9 5.302 9.448 5.75 10 5.75 L12.75 5.75" />
      <line x1="5.5" y1="5.75" x2="7" y2="5.75" />
      <line x1="5.5" y1="8.5" x2="10.5" y2="8.5" />
      <line x1="5.5" y1="11" x2="10.5" y2="11" />
    </g>
  </Svg>
);

/** iconmcp: file-edit */
export const FileEditIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M5.25 2 L9 2 L12.75 5.75 L12.75 12 C12.75 13.105 11.855 14 10.75 14 L5.25 14 C4.145 14 3.25 13.105 3.25 12 L3.25 4 C3.25 2.895 4.145 2 5.25 2 Z" />
      <path d="M9 2 L9 4.75 C9 5.302 9.448 5.75 10 5.75 L12.75 5.75" />
      <path d="M9.674 7.424 L10.576 8.326 C10.81 8.56 10.81 8.94 10.576 9.174 L7.926 11.824 C7.813 11.937 7.661 12 7.501 12 L6 12 L6 10.499 C6 10.339 6.063 10.187 6.176 10.074 L8.826 7.424 C9.06 7.19 9.44 7.19 9.674 7.424 Z" />
    </g>
  </Svg>
);

/** iconmcp: alert-circle */
export const ErrorCircleIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="5.25" x2="8" y2="8.75" />
      <circle cx="8" cy="11.15" r="0.99" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: brain */
export const ThoughtIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M8 3.5 A2.25 2.25 0 0 0 4 4.25 A2.5 2.5 0 0 0 2.75 8.5 A2.5 2.5 0 0 0 5 12.75 A2 2 0 0 0 8 13" />
      <path d="M8 3.5 A2.25 2.25 0 0 1 12 4.25 A2.5 2.5 0 0 1 13.25 8.5 A2.5 2.5 0 0 1 11 12.75 A2 2 0 0 1 8 13" />
      <line x1="8" y1="3.5" x2="8" y2="13" />
    </g>
  </Svg>
);

/** iconmcp: ai-task */
export const PlanIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M4 2 C4.175 3.138 4.612 3.575 5.75 3.75 C4.612 3.925 4.175 4.362 4 5.5 C3.825 4.362 3.388 3.925 2.25 3.75 C3.388 3.575 3.825 3.138 4 2 Z" />
      <line x1="8" y1="3.75" x2="13.75" y2="3.75" />
      <path d="M2.25 8.25 L3.5 9.5 L5.75 7" />
      <line x1="8" y1="8.25" x2="13.75" y2="8.25" />
      <path d="M2.25 12.5 L3.5 13.75 L5.75 11.25" />
      <line x1="8" y1="12.5" x2="13.75" y2="12.5" />
    </g>
  </Svg>
);

/** iconmcp: wrench */
export const ToolIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M8.63 9.13 A3.75 3.75 0 0 0 13.7 4.28 L11.42 6.56 L9.44 4.58 L11.72 2.3 A3.75 3.75 0 0 0 6.87 7.37 L2.83 11.41 A1.25 1.25 0 0 0 4.59 13.17 Z" />
    </g>
  </Svg>
);

/** iconmcp: sidebar-left */
export const SidebarIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <line x1="6" y1="2.75" x2="6" y2="13.25" />
    </g>
  </Svg>
);

/** iconmcp: download */
export const DownloadIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <line x1="8" y1="2.25" x2="8" y2="9.25" />
      <path d="M4.75 6 L8 9.25 L11.25 6" />
      <path d="M2.5 10.5 L2.5 12 C2.5 12.828 3.172 13.5 4 13.5 L12 13.5 C12.828 13.5 13.5 12.828 13.5 12 L13.5 10.5" />
    </g>
  </Svg>
);

/** iconmcp: copy */
export const CopyIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="2" />
      <path d="M3.5 10.75 L2.875 10.75 C2.53 10.75 2.25 10.47 2.25 10.125 L2.25 4.25 C2.25 3.145 3.145 2.25 4.25 2.25 L10.125 2.25 C10.47 2.25 10.75 2.53 10.75 2.875 L10.75 3.5" />
    </g>
  </Svg>
);
