/**
 * Excel-style SVG icon library for the icecream-sheets ribbon.
 *
 * Every icon is a 24x24 viewBox, stroke-based (currentColor) component in
 * Excel's visual language, so ribbon buttons get proper icons instead of
 * text-only labels. Icons are decorative by default (aria-hidden) unless a
 * `title` is supplied.
 *
 * Usage:
 *   import { IconCut, ribbonIcons } from './icons';
 *   <RibbonButton label="Cut" icon={<IconCut />} ... />
 */
import type { ReactElement, ReactNode } from 'react';

export interface RibbonIconProps {
  /** Pixel size of the square icon. Defaults to 24 (CSS may override in buttons). */
  size?: number;
  className?: string;
  /** Accessible title; when omitted the icon is aria-hidden (decorative). */
  title?: string;
}

function Svg({ size = 24, className, title, children }: RibbonIconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export type RibbonSvgIcon = (props: RibbonIconProps) => ReactElement;

function makeIcon(children: ReactNode): RibbonSvgIcon {
  return function RibbonSvgIcon(props: RibbonIconProps) {
    return <Svg {...props}>{children}</Svg>;
  };
}

/** Shared font stack for letter glyphs (B, I, U, fx, …). */
const GLYPH_FONT = 'Segoe UI, Arial, sans-serif';

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

export const IconCut = makeIcon(
  <>
    <circle cx="6" cy="6" r="2.6" />
    <circle cx="6" cy="18" r="2.6" />
    <path d="M8.2 7.8 20 19.5" />
    <path d="M8.2 16.2 20 4.5" />
  </>,
);

export const IconCopy = makeIcon(
  <>
    <path d="M15 9V6.5A1.5 1.5 0 0 0 13.5 5h-9A1.5 1.5 0 0 0 3 6.5v9A1.5 1.5 0 0 0 4.5 17H9" />
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
  </>,
);

export const IconPaste = makeIcon(
  <>
    <rect x="5" y="4.5" width="14" height="16" rx="2" />
    <path d="M9 4.5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5" />
    <path d="M9 11h6" />
    <path d="M9 14.5h6" />
    <path d="M9 18h3.5" />
  </>,
);

export const IconPasteSpecial = makeIcon(
  <>
    <rect x="3.5" y="6" width="11" height="14" rx="2" />
    <path d="M7 6V4.6A1.1 1.1 0 0 1 8.1 3.5h3.3a1.1 1.1 0 0 1 1.1 1.1V6" />
    <path d="M18.5 3l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" />
    <path d="M7.5 11h4" />
    <path d="M7.5 14.5h4" />
  </>,
);

export const IconFormatPainter = makeIcon(
  <>
    <path d="M14.8 3.6l5.6 5.6-9.7 9.7a2.4 2.4 0 0 1-3.4-3.4z" />
    <path d="M12.4 6l5.6 5.6" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Font                                                                */
/* ------------------------------------------------------------------ */

export const IconBold = makeIcon(
  <text x="7" y="17.5" fontSize="15" fontWeight="800" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
    B
  </text>,
);

export const IconItalic = makeIcon(
  <text x="9" y="17.5" fontSize="15" fontWeight="600" fontStyle="italic" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
    I
  </text>,
);

export const IconUnderline = makeIcon(
  <>
    <text x="7" y="16.5" fontSize="14" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      U
    </text>
    <path d="M6 20h12" />
  </>,
);

export const IconDoubleUnderline = makeIcon(
  <>
    <text x="7" y="15" fontSize="13" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      U
    </text>
    <path d="M6 18.5h12" />
    <path d="M6 21.5h12" />
  </>,
);

export const IconStrikethrough = makeIcon(
  <>
    <text x="7" y="17" fontSize="14" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      S
    </text>
    <path d="M5 12.5h14" />
  </>,
);

export const IconFontColor = makeIcon(
  <>
    <text x="7" y="16.5" fontSize="14" fontWeight="600" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A
    </text>
    <rect x="6" y="18.5" width="12" height="3" rx="0.5" fill="#D64541" stroke="none" />
  </>,
);

export const IconFillColor = makeIcon(
  <>
    <path d="M4.6 13.8 13.2 5.2l5.6 5.6-8.6 8.6H4.6z" />
    <path d="M13.2 5.2 15.4 3l5.6 5.6-2.2 2.2" />
    <path d="M8.6 17.4c1.2 1.5 2 2.6 2 3.6a2 2 0 0 1-4 0c0-1 .8-2.1 2-3.6z" />
  </>,
);

export const IconBorders = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" strokeWidth={2.4} />
    <path d="M4 9.3h16" />
    <path d="M4 14.7h16" />
    <path d="M9.3 4v16" />
    <path d="M14.7 4v16" />
  </>,
);

export const IconDrawBorders = makeIcon(
  <>
    <rect x="3" y="8" width="11" height="11" />
    <path d="M3 11.7h11" />
    <path d="M3 15.3h11" />
    <path d="M6.7 8v11" />
    <path d="M10.3 8v11" />
    <path d="M14.5 19.5l6.8-6.8 2.2 2.2-6.8 6.8h-3.2z" />
    <path d="M19 10.4l2.5-2.5 2 2-2.5 2.5" />
  </>,
);

export const IconFontGrow = makeIcon(
  <>
    <text x="5" y="17" fontSize="13" fontWeight="700" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A
    </text>
    <path d="M17.5 13V7" />
    <path d="M14.5 10l3-3 3 3" />
  </>,
);

export const IconFontShrink = makeIcon(
  <>
    <text x="5" y="17" fontSize="13" fontWeight="700" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A
    </text>
    <path d="M17.5 7v6" />
    <path d="M14.5 10l3 3 3-3" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Alignment                                                           */
/* ------------------------------------------------------------------ */

export const IconAlignLeft = makeIcon(
  <>
    <path d="M4 6h16" />
    <path d="M4 12h10" />
    <path d="M4 18h16" />
  </>,
);

export const IconAlignCenter = makeIcon(
  <>
    <path d="M4 6h16" />
    <path d="M7 12h10" />
    <path d="M4 18h16" />
  </>,
);

export const IconAlignRight = makeIcon(
  <>
    <path d="M4 6h16" />
    <path d="M10 12h10" />
    <path d="M4 18h16" />
  </>,
);

export const IconJustify = makeIcon(
  <>
    <path d="M4 5.5h16" />
    <path d="M4 10.5h16" />
    <path d="M4 15.5h16" />
    <path d="M4 20.5h16" />
  </>,
);

export const IconAlignTop = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M8 8.5h8" />
    <path d="M8 12.5h8" />
  </>,
);

export const IconAlignMiddle = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M8 10.5h8" />
    <path d="M8 14.5h8" />
  </>,
);

export const IconAlignBottom = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M8 12.5h8" />
    <path d="M8 16.5h8" />
  </>,
);

export const IconWrapText = makeIcon(
  <>
    <path d="M4 6h10" />
    <path d="M4 11h16" />
    <path d="M15 8.5V14a2 2 0 0 1-2 2H8" />
  </>,
);

export const IconIndentIncrease = makeIcon(
  <>
    <path d="M4 6h8" />
    <path d="M4 11h8" />
    <path d="M4 16h8" />
    <path d="M14.5 8.5h6" />
    <path d="M18 6l2.5 2.5L18 11" />
  </>,
);

export const IconIndentDecrease = makeIcon(
  <>
    <path d="M12 6h8" />
    <path d="M12 11h8" />
    <path d="M12 16h8" />
    <path d="M9.5 8.5h-6" />
    <path d="M6 6L3.5 8.5 6 11" />
  </>,
);

export const IconOrientation = makeIcon(
  <>
    <text
      x="6"
      y="17"
      fontSize="11"
      fill="currentColor"
      stroke="none"
      fontFamily={GLYPH_FONT}
      transform="rotate(-35 12 12)"
    >
      abc
    </text>
    <path d="M4 20.5h16" />
  </>,
);

export const IconMergeCenter = makeIcon(
  <>
    <rect x="3" y="8" width="18" height="9" />
    <path d="M9 8v9" />
    <path d="M15 8v9" />
    <path d="M6.5 12.5h11" />
  </>,
);

export const IconMerge = makeIcon(
  <>
    <rect x="4" y="8" width="16" height="9" />
    <path d="M12 8v9" />
  </>,
);

export const IconUnmerge = makeIcon(
  <>
    <rect x="4" y="8" width="16" height="9" strokeDasharray="3 2.5" />
    <path d="M12 8v9" strokeDasharray="3 2.5" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Number                                                              */
/* ------------------------------------------------------------------ */

export const IconPercent = makeIcon(
  <>
    <path d="M19 5 5 19" />
    <circle cx="7.5" cy="7.5" r="2.5" />
    <circle cx="16.5" cy="16.5" r="2.5" />
  </>,
);

export const IconComma = makeIcon(
  <>
    <path d="M12 4v13" />
    <path d="M17.5 15.5c.6 1.6-.4 3.4-2.2 4" />
  </>,
);

export const IconAccounting = makeIcon(
  <>
    <path d="M12 3v18" />
    <path d="M16 6.8C15.2 5.9 13.7 5.3 12 5.3c-2.6 0-4.3 1.4-4.3 3.4 0 4.7 9.6 2.4 9.6 7.1 0 2-1.9 3.4-4.5 3.4-1.6 0-3-.6-3.8-1.6" />
  </>,
);

export const IconIncreaseDecimal = makeIcon(
  <text x="3" y="16" fontSize="9.5" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
    .0→.00
  </text>,
);

export const IconDecreaseDecimal = makeIcon(
  <text x="3" y="16" fontSize="9.5" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
    .00→.0
  </text>,
);

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

export const IconConditionalFormatting = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <rect x="4" y="4" width="8" height="8" fill="#C00000" stroke="none" opacity="0.75" />
    <rect x="12" y="12" width="8" height="8" fill="#2F7ED8" stroke="none" opacity="0.75" />
  </>,
);

export const IconCellStyles = makeIcon(
  <>
    <text x="4.5" y="17" fontSize="13" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A
    </text>
    <path d="M15 4.5l5 5-7.5 7.5-5-5z" />
    <path d="M10.5 17l-3 3" />
  </>,
);

export const IconFormatAsTable = makeIcon(
  <>
    <rect x="4" y="5" width="16" height="15" />
    <rect x="4" y="5" width="16" height="5" fill="#2F7ED8" stroke="none" opacity="0.65" />
    <path d="M4 10h16" />
    <path d="M4 15h16" />
    <path d="M9.3 5v15" />
    <path d="M14.7 5v15" />
  </>,
);

export const IconManageRules = makeIcon(
  <>
    <path d="M4 6h11" />
    <path d="M4 11h11" />
    <path d="M4 16h11" />
    <path d="M16.5 14.5l2 2 3.5-3.5" />
  </>,
);

export const IconNewRule = makeIcon(
  <>
    <path d="M4 6h10" />
    <path d="M4 11h10" />
    <path d="M4 16h10" />
    <circle cx="17.5" cy="17" r="3.8" />
    <path d="M17.5 15v4" />
    <path d="M15.5 17h4" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Cells                                                               */
/* ------------------------------------------------------------------ */

export const IconInsertRow = makeIcon(
  <>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h9" />
    <circle cx="18" cy="18" r="3.6" />
    <path d="M18 16.2v3.6" />
    <path d="M16.2 18h3.6" />
  </>,
);

export const IconInsertColumn = makeIcon(
  <>
    <path d="M7 4v16" />
    <path d="M12 4v16" />
    <path d="M17 4v10" />
    <circle cx="18" cy="18" r="3.6" />
    <path d="M18 16.2v3.6" />
    <path d="M16.2 18h3.6" />
  </>,
);

export const IconDeleteRow = makeIcon(
  <>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h9" />
    <circle cx="17.5" cy="17.5" r="3.6" />
    <path d="M15.7 17.5h3.6" />
  </>,
);

export const IconDeleteColumn = makeIcon(
  <>
    <path d="M7 4v16" />
    <path d="M12 4v16" />
    <path d="M17 4v10" />
    <circle cx="17.5" cy="17.5" r="3.6" />
    <path d="M15.7 17.5h3.6" />
  </>,
);

export const IconRowHeight = makeIcon(
  <>
    <path d="M4 7h16" />
    <path d="M4 17h16" />
    <path d="M12 7v10" />
    <path d="M9.5 9.5 12 7l2.5 2.5" />
    <path d="M9.5 14.5 12 17l2.5-2.5" />
  </>,
);

export const IconColWidth = makeIcon(
  <>
    <path d="M7 4v16" />
    <path d="M17 4v16" />
    <path d="M7 12h10" />
    <path d="M9.5 9.5 7 12l2.5 2.5" />
    <path d="M14.5 9.5 17 12l-2.5 2.5" />
  </>,
);

export const IconAutofitRow = makeIcon(
  <>
    <path d="M4 6h16" />
    <path d="M4 18h16" />
    <path d="M12 6v4" />
    <path d="M12 14v4" />
    <path d="M9.5 8.5 12 6l2.5 2.5" />
    <path d="M9.5 15.5 12 18l2.5-2.5" />
  </>,
);

export const IconAutofitCol = makeIcon(
  <>
    <path d="M6 4v16" />
    <path d="M18 4v16" />
    <path d="M6 12h4" />
    <path d="M14 12h4" />
    <path d="M8.5 9.5 6 12l2.5 2.5" />
    <path d="M15.5 9.5 18 12l-2.5 2.5" />
  </>,
);

export const IconFormatCells = makeIcon(
  <>
    <rect x="3" y="3" width="12" height="12" />
    <path d="M3 7h12" />
    <path d="M3 11h12" />
    <path d="M7 3v12" />
    <path d="M11 3v12" />
    <path d="M13.5 20.5l6.5-6.5 2 2-6.5 6.5h-2.5z" />
    <path d="M18.5 11.5l2.5-2.5 1.5 1.5-2.5 2.5" />
  </>,
);

export const IconMoveOrCopySheet = makeIcon(
  <>
    <path d="M10 3h7l4 4v12h-11z" />
    <path d="M17 3v4h4" />
    <path d="M3 8h8v13H3z" />
    <path d="M13.5 12.5h5" />
    <path d="M16 10l2.5 2.5L16 15" />
  </>,
);

export const IconHideRow = makeIcon(
  <>
    <path d="M6 8h12" />
    <path d="M6 12h12" />
    <path d="M6 16h12" />
    <path d="M4 4l16 16" />
  </>,
);

export const IconHideColumn = makeIcon(
  <>
    <path d="M7 6v12" />
    <path d="M12 6v12" />
    <path d="M17 6v12" />
    <path d="M4 4l16 16" />
  </>,
);

export const IconHideUnhide = makeIcon(
  <>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const IconRenameSheet = makeIcon(
  <>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M9 15l4.5-4.5 2 2L11 17H9z" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

export const IconAutoSum = makeIcon(<path d="M17.5 5.5H7.5l6 6.5-6 6.5h10" />);

export const IconFill = makeIcon(
  <>
    <rect x="4" y="4" width="7" height="7" />
    <path d="M7.5 13.5V20" />
    <path d="M5 17.5 7.5 20 10 17.5" />
  </>,
);

export const IconFillDown = makeIcon(
  <>
    <rect x="8" y="3" width="8" height="8" />
    <path d="M12 13.5V21" />
    <path d="M9.5 18.5 12 21 14.5 18.5" />
  </>,
);

export const IconFillUp = makeIcon(
  <>
    <rect x="8" y="13" width="8" height="8" />
    <path d="M12 3v7.5" />
    <path d="M9.5 5.5 12 3 14.5 5.5" />
  </>,
);

export const IconFillRight = makeIcon(
  <>
    <rect x="3" y="8" width="8" height="8" />
    <path d="M13.5 12H21" />
    <path d="M18.5 9.5 21 12 18.5 14.5" />
  </>,
);

export const IconFillLeft = makeIcon(
  <>
    <rect x="13" y="8" width="8" height="8" />
    <path d="M3 12h7.5" />
    <path d="M5.5 9.5 3 12l2.5 2.5" />
  </>,
);

export const IconFillSeries = makeIcon(
  <>
    <text x="6" y="9.5" fontSize="7" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      1
    </text>
    <text x="6" y="15.5" fontSize="7" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      2
    </text>
    <text x="6" y="21.5" fontSize="7" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      3
    </text>
    <path d="M15 5v14" />
    <path d="M12.5 16.5 15 19 17.5 16.5" />
  </>,
);

export const IconClear = makeIcon(
  <>
    <path d="M4 6h12" />
    <path d="M4 11h16" />
    <path d="M4 16h8" />
    <path d="M16.5 14.5l5 5" />
    <path d="M21.5 14.5l-5 5" />
  </>,
);

export const IconUndo = makeIcon(
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 6 6v1" />
  </>,
);

export const IconRedo = makeIcon(
  <>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0-6 6v1" />
  </>,
);

export const IconSortAsc = makeIcon(
  <>
    <text x="5" y="10" fontSize="9" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A
    </text>
    <text x="5" y="20" fontSize="9" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      Z
    </text>
    <path d="M16 5v14" />
    <path d="M13.5 16.5 16 19l2.5-2.5" />
  </>,
);

export const IconSortDesc = makeIcon(
  <>
    <text x="5" y="10" fontSize="9" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      Z
    </text>
    <text x="5" y="20" fontSize="9" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A
    </text>
    <path d="M16 5v14" />
    <path d="M13.5 7.5 16 5l2.5 2.5" />
  </>,
);

export const IconCustomSort = makeIcon(
  <>
    <path d="M5 6h6" />
    <path d="M5 12h10" />
    <path d="M5 18h4" />
    <circle cx="17" cy="17" r="4" />
    <path d="M17 13.5v4" />
    <path d="M15.5 16 17 17.5 18.5 16" />
  </>,
);

export const IconSortFilter = makeIcon(
  <>
    <path d="M3 6h8" />
    <path d="M3 11h8" />
    <path d="M3 16h5" />
    <path d="M15 4h6l-2.5 3v4l-1.5 1v-5z" />
  </>,
);

export const IconFilter = makeIcon(<path d="M4 5h16l-6 7v6l-4 2v-8z" />);

export const IconReapplyFilter = makeIcon(
  <>
    <path d="M4 6h11l-4.2 5v4l-2.6 1.4V11z" />
    <path d="M15.5 4a6 6 0 0 1 4.5 4" />
    <path d="M20 4v4h-4" />
  </>,
);

export const IconAdvancedFilter = makeIcon(
  <>
    <path d="M6 4h12l-4.5 5.5V15l-3 1.5V9.5z" />
    <path d="M4 19h4.5" />
    <path d="M13.5 19h6.5" />
    <circle cx="11" cy="19" r="2.2" />
  </>,
);

export const IconFind = makeIcon(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="M15.8 15.8 20 20" />
  </>,
);

export const IconReplace = makeIcon(
  <>
    <circle cx="10" cy="9.5" r="5" />
    <path d="M13.8 13.3 17 16.5" />
    <path d="M15 18h6" />
    <path d="M19 16l2 2-2 2" />
    <path d="M21 22h-6" />
    <path d="M17 20l-2 2 2 2" />
  </>,
);

export const IconGoTo = makeIcon(
  <>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M12 2v3.5" />
    <path d="M12 18.5V22" />
    <path d="M2 12h3.5" />
    <path d="M18.5 12H22" />
  </>,
);

export const IconGoToSpecial = makeIcon(
  <>
    <circle cx="10" cy="10" r="5.5" />
    <path d="M10 2.5V6" />
    <path d="M10 14v3.5" />
    <path d="M2.5 10H6" />
    <path d="M14 10h3.5" />
    <path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </>,
);

export const IconSelectObjects = makeIcon(
  <>
    <path d="M7 3.5l9.5 8.2-4.3 1L14.5 17l-2.4 1.4-2.3-4.3-3.2 3.7z" />
    <rect x="14" y="14" width="7" height="7" strokeDasharray="2.5 2" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Insert: Tables, Illustrations, Charts, Sparklines                    */
/* ------------------------------------------------------------------ */

export const IconTable = makeIcon(
  <>
    <rect x="3" y="5" width="18" height="14" />
    <path d="M3 10h18" />
    <path d="M3 15h18" />
    <path d="M9 5v14" />
    <path d="M15 5v14" />
  </>,
);

export const IconPivotTable = makeIcon(
  <>
    <rect x="4" y="4" width="9" height="9" />
    <path d="M4 8.5h9" />
    <path d="M8.5 4v9" />
    <path d="M14 18c0-4 3-7 7-7" />
    <path d="M18 8.5 21 11l2.5-2.5" />
  </>,
);

export const IconRecommendedPivot = makeIcon(
  <>
    <rect x="3" y="9" width="10" height="10" />
    <path d="M3 14h10" />
    <path d="M8 9v10" />
    <path d="M17 3l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" />
  </>,
);

export const IconPivotChart = makeIcon(
  <>
    <path d="M4 20h16" />
    <path d="M7 20v-6" />
    <path d="M12 20V9" />
    <path d="M17 20v-9" />
    <path d="M6 9a6 6 0 0 1 5-4" />
    <path d="M9 2.5l2 2.5 2.5-2" />
  </>,
);

export const IconRecommendedChart = makeIcon(
  <>
    <path d="M4 20h11" />
    <path d="M5 20v-5" />
    <path d="M9.5 20v-9" />
    <path d="M14 20V8" />
    <path d="M18 3l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" />
  </>,
);

export const IconPicture = makeIcon(
  <>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="M5 17l4.5-5 3 3.5 2.5-2.5L20 17" />
  </>,
);

export const IconShapes = makeIcon(
  <>
    <rect x="3" y="13" width="7.5" height="7.5" />
    <circle cx="16.5" cy="8" r="4.5" />
    <path d="M13 20.5l3.5-6 3.5 6z" />
  </>,
);

export const IconIcons = makeIcon(
  <>
    <path d="M12 3a6 6 0 0 1 3.6 10.8c-.8.6-1.6 1.4-1.6 2.2H10c0-.8-.8-1.6-1.6-2.2A6 6 0 0 1 12 3z" />
    <path d="M10 19h4" />
    <path d="M10.8 21.5h2.4" />
  </>,
);

export const IconSmartArt = makeIcon(
  <>
    <rect x="3" y="4" width="8" height="6" rx="1" />
    <rect x="13" y="14" width="8" height="6" rx="1" />
    <path d="M7 10v2.5a1.5 1.5 0 0 0 1.5 1.5H15" />
    <path d="M13.5 12.5 15 14l1.5-1.5" />
  </>,
);

export const IconScreenshot = makeIcon(
  <>
    <rect x="3" y="5" width="18" height="12" rx="1.5" />
    <path d="M9 21h6" />
    <path d="M12 17v4" />
    <circle cx="17" cy="13" r="2.6" />
    <circle cx="17" cy="13" r="1" fill="currentColor" stroke="none" />
  </>,
);

export const IconMapChart = makeIcon(
  <>
    <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
    <path d="M9 4v14" />
    <path d="M15 6v14" />
    <path d="M12 19.5s-4.2-4.9-4.2-8a4.2 4.2 0 0 1 8.4 0c0 3.1-4.2 8-4.2 8z" />
    <circle cx="12" cy="11.5" r="1.5" />
  </>,
);

/** 3D Map (task name "3dMap"). */
export const IconMap3d = makeIcon(
  <>
    <circle cx="11" cy="12" r="8" />
    <path d="M3 12h16" />
    <path d="M11 4c2.8 2.3 4 5 4 8s-1.2 5.7-4 8c-2.8-2.3-4-5-4-8s1.2-5.7 4-8z" />
    <path d="M18.5 19.5s-2.6-3-2.6-5a2.6 2.6 0 0 1 5.2 0c0 2-2.6 5-2.6 5z" />
  </>,
);

export const IconChartLine = makeIcon(
  <>
    <path d="M4 4v16h16" />
    <path d="M7 15l4-5 3 3 5-7" />
  </>,
);

export const IconChartColumn = makeIcon(
  <>
    <path d="M4 4v16h16" />
    <path d="M8 20v-7" />
    <path d="M12.5 20v-11" />
    <path d="M17 20V9" />
  </>,
);

export const IconChartPie = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 12V4" />
    <path d="M12 12l5.7 5.7" />
  </>,
);

export const IconInsertChart = makeIcon(
  <>
    <path d="M4 20h12" />
    <path d="M7 20v-6" />
    <path d="M11.5 20v-10" />
    <path d="M16 20v-4" />
    <circle cx="18.5" cy="5.5" r="3" />
    <path d="M18.5 4v3" />
    <path d="M17 5.5h3" />
  </>,
);

export const IconSparkline = makeIcon(
  <>
    <rect x="3" y="6" width="18" height="12" rx="1" />
    <path d="M6 14l3-4 3 3 3-5 3 3" />
  </>,
);

export const IconRemoveSparkline = makeIcon(
  <>
    <rect x="3" y="6" width="18" height="12" rx="1" />
    <path d="M6 14l3-4 3 3 3-5 3 3" />
    <circle cx="18.5" cy="5.5" r="3.2" />
    <path d="M17.2 4.2l2.6 2.6" />
    <path d="M19.8 4.2l-2.6 2.6" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Insert: Filters, Links, Text, Symbols                               */
/* ------------------------------------------------------------------ */

export const IconSlicer = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <rect x="7" y="7" width="4" height="4" />
    <rect x="13" y="7" width="4" height="4" />
    <rect x="7" y="13" width="4" height="4" />
    <rect x="13" y="13" width="4" height="4" fill="currentColor" stroke="none" opacity="0.35" />
  </>,
);

export const IconTimeline = makeIcon(
  <>
    <path d="M3 12h18" />
    <path d="M6 9v6" />
    <path d="M12 9v6" />
    <path d="M18 9v6" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
  </>,
);

export const IconHyperlink = makeIcon(
  <>
    <path d="M10 14a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.6-5.6l-1.7 1.7" />
    <path d="M14 10a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.6 5.6l1.7-1.7" />
  </>,
);

/** Alias: the generic "Link" command shares the hyperlink glyph. */
export const IconLink = IconHyperlink;

export const IconUnlink = makeIcon(
  <>
    <path d="M10 13a3.5 3.5 0 0 0 5 .5l1.5-1.5" />
    <path d="M14 11a3.5 3.5 0 0 0-5-.5L7.5 12" />
    <path d="M4 4l16 16" />
  </>,
);

export const IconTextBox = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="1" />
    <text x="8.5" y="17" fontSize="12" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A
    </text>
  </>,
);

export const IconHeaderFooter = makeIcon(
  <>
    <rect x="6" y="3" width="12" height="18" rx="1" />
    <path d="M6 7h12" />
    <path d="M6 17h12" />
    <path d="M9 11h6" />
    <path d="M9 14h6" />
  </>,
);

export const IconWordArt = makeIcon(
  <>
    <text
      x="7"
      y="18"
      fontSize="15"
      fontWeight="700"
      fontStyle="italic"
      fill="currentColor"
      stroke="none"
      fontFamily={GLYPH_FONT}
    >
      A
    </text>
    <path d="M5 20c4 1 10 1 14-2" />
  </>,
);

export const IconSignatureLine = makeIcon(
  <>
    <path d="M3 18h18" />
    <path d="M6 18c.8-4.5 1.8-7.5 2.8-7.5s.6 4.5 1.6 4.5 1-5.5 2-5.5 1 6.5 2.4 6.5 1.4-2.8 2.8-2.8" />
  </>,
);

export const IconObject = makeIcon(
  <>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M12 12l8-4.5" />
    <path d="M12 12 4 7.5" />
    <path d="M12 12v9" />
  </>,
);

export const IconEquation = makeIcon(
  <text x="8" y="17" fontSize="14" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
    π
  </text>,
);

export const IconSymbol = makeIcon(
  <text x="7" y="17" fontSize="14" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
    Ω
  </text>,
);

export const IconFormControls = makeIcon(
  <>
    <rect x="4" y="4" width="6" height="6" />
    <path d="M5.5 7l1.5 1.5L10 5.5" />
    <circle cx="17" cy="7" r="3" />
    <circle cx="17" cy="7" r="1" fill="currentColor" stroke="none" />
    <rect x="4" y="14" width="16" height="6" rx="3" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Draw                                                                */
/* ------------------------------------------------------------------ */

export const IconPen = makeIcon(
  <>
    <path d="M4 20l1-4L16.5 4.5a2.12 2.12 0 0 1 3 3L8 19z" />
    <path d="M14.5 6.5l3 3" />
  </>,
);

export const IconHighlighter = makeIcon(
  <>
    <path d="M4 16l8-8 4 4-8 8H4z" />
    <path d="M12 8l3.2-3.2 4.8 4.8-3.2 3.2" />
    <path d="M2.5 21.5h7" />
  </>,
);

export const IconEraser = makeIcon(
  <>
    <path d="M6.5 15.5l6.8-6.8a1.5 1.5 0 0 1 2.1 0l2.9 2.9a1.5 1.5 0 0 1 0 2.1l-4.2 4.2H9.3z" />
    <path d="M3 21h18" />
  </>,
);

export const IconRuler = makeIcon(
  <>
    <rect x="2.5" y="9" width="19" height="6" />
    <path d="M7 9v3" />
    <path d="M11 9v4" />
    <path d="M15 9v3" />
    <path d="M19 9v4" />
  </>,
);

export const IconInkToText = makeIcon(
  <>
    <path d="M3 20l.8-3L12 8.8" />
    <path d="M10.5 10.3l2.5 2.5" />
    <text x="14" y="19" fontSize="10" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A
    </text>
  </>,
);

export const IconLasso = makeIcon(
  <>
    <ellipse cx="11" cy="11" rx="7" ry="6" strokeDasharray="3 2.5" />
    <path d="M16.3 16.3 21 21" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Page Layout                                                         */
/* ------------------------------------------------------------------ */

export const IconThemes = makeIcon(
  <>
    <circle cx="8" cy="8" r="3" fill="#2F7ED8" stroke="none" />
    <circle cx="16" cy="8" r="3" fill="#70AD47" stroke="none" />
    <circle cx="8" cy="16" r="3" fill="#FFC000" stroke="none" />
    <circle cx="16" cy="16" r="3" fill="#ED7D31" stroke="none" />
  </>,
);

export const IconMargins = makeIcon(
  <>
    <rect x="6" y="3" width="12" height="18" />
    <path d="M9.5 3v18" strokeDasharray="2.5 2.5" />
    <path d="M14.5 3v18" strokeDasharray="2.5 2.5" />
  </>,
);

export const IconPageOrientation = makeIcon(
  <>
    <rect x="7" y="4" width="10" height="16" rx="1" />
    <path d="M18 19a7 7 0 0 0 3-5.5" />
    <path d="M18.6 10.8 21 13.5l2.4-2.7" />
  </>,
);

export const IconPageSize = makeIcon(
  <>
    <path d="M8 3h8l4 4v14H8z" />
    <path d="M16 3v4h4" />
    <path d="M4 7h4v14H4z" />
  </>,
);

export const IconPrintArea = makeIcon(
  <>
    <rect x="6" y="3" width="12" height="18" rx="1" />
    <rect x="9" y="9" width="6.5" height="7" strokeDasharray="2.5 2" />
  </>,
);

export const IconPageBreaks = makeIcon(
  <>
    <rect x="6" y="3" width="12" height="18" rx="1" />
    <path d="M3 12h18" strokeDasharray="3 2" />
  </>,
);

export const IconPrintTitles = makeIcon(
  <>
    <rect x="4" y="5" width="16" height="14" />
    <path d="M4 9.5h16" />
    <path d="M12 12v7" />
    <path d="M9.5 16.5 12 19l2.5-2.5" />
  </>,
);

export const IconScaleToFit = makeIcon(
  <>
    <path d="M4 8V5a1 1 0 0 1 1-1h3" />
    <path d="M16 4h3a1 1 0 0 1 1 1v3" />
    <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
    <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
    <rect x="8.5" y="7.5" width="7" height="9" />
  </>,
);

export const IconBringForward = makeIcon(
  <>
    <rect x="8" y="8" width="12" height="12" rx="1" />
    <rect x="4" y="4" width="12" height="12" rx="1" />
    <path d="M10 1v2.6" />
    <path d="M8.2 2 10 .6 11.8 2" />
  </>,
);

export const IconSendBackward = makeIcon(
  <>
    <rect x="8" y="4" width="12" height="12" rx="1" />
    <rect x="4" y="8" width="12" height="12" rx="1" />
    <path d="M10 20.8v2.4" />
    <path d="M8.2 21.8 10 23.4l1.8-1.6" />
  </>,
);

export const IconSelectionPane = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M7 8.5h10" />
    <path d="M7 12h10" />
    <path d="M7 15.5h6" />
    <path d="M16.5 14.5l4 1.5-4 1.5" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Formulas                                                            */
/* ------------------------------------------------------------------ */

export const IconInsertFunction = makeIcon(
  <text x="6" y="17.5" fontSize="13" fontStyle="italic" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
    fx
  </text>,
);

export const IconDefineName = makeIcon(
  <>
    <path d="M4 4h7l9 9-7 7-9-9z" />
    <circle cx="9" cy="9" r="1.6" />
  </>,
);

export const IconNameManager = makeIcon(
  <>
    <path d="M3 4h6.5L14 8.5 9.5 13H3z" />
    <circle cx="7" cy="8.5" r="1.3" />
    <path d="M10 12h6.5L21 16.5 16.5 21H10z" />
    <circle cx="14" cy="16.5" r="1.3" />
  </>,
);

export const IconUseInFormula = makeIcon(
  <>
    <text x="4" y="17" fontSize="12" fontStyle="italic" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      fx
    </text>
    <path d="M14 15.5h7" />
    <path d="M18.5 13 21 15.5 18.5 18" />
  </>,
);

export const IconApplyNames = makeIcon(
  <>
    <path d="M3 5h6l7 7-7 7H3z" />
    <circle cx="7.5" cy="9.5" r="1.4" />
    <path d="M14.5 15.5l2 2 4-4" />
  </>,
);

export const IconCreateFromSelection = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M4 12h16" />
    <path d="M12 4v16" />
    <path d="M16.5 16.5 21 21" />
    <path d="M21 16.5V21h-4.5" />
  </>,
);

export const IconTracePrecedents = makeIcon(
  <>
    <rect x="9.5" y="9.5" width="5" height="5" />
    <path d="M3 12h4.5" />
    <path d="M5.5 10l2 2-2 2" />
    <path d="M21 12h-4.5" />
    <path d="M18.5 10l-2 2 2 2" />
  </>,
);

export const IconTraceDependents = makeIcon(
  <>
    <rect x="9.5" y="9.5" width="5" height="5" />
    <path d="M9.5 12H5" />
    <path d="M7.5 10 5 12l2.5 2" />
    <path d="M14.5 12H19" />
    <path d="M16.5 10 19 12l-2.5 2" />
  </>,
);

export const IconRemoveArrows = makeIcon(
  <>
    <path d="M4 12h7" />
    <path d="M8.5 9.5 11 12l-2.5 2.5" />
    <circle cx="17.5" cy="16.5" r="4" />
    <path d="M15.7 14.7l3.6 3.6" />
    <path d="M19.3 14.7l-3.6 3.6" />
  </>,
);

export const IconShowFormulas = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M4 12h16" />
    <path d="M12 4v16" />
    <text x="5.5" y="11" fontSize="7" fontStyle="italic" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      fx
    </text>
  </>,
);

export const IconErrorChecking = makeIcon(
  <>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l4.5 4.5" />
    <path d="M10.5 7.5v4" />
    <circle cx="10.5" cy="14.5" r="1" fill="currentColor" stroke="none" />
  </>,
);

export const IconEvaluateFormula = makeIcon(
  <>
    <text x="4" y="17" fontSize="12" fontStyle="italic" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      fx
    </text>
    <path d="M14.5 16.5l2 2 4.5-4.5" />
  </>,
);

export const IconWatchWindow = makeIcon(
  <>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.5" />
  </>,
);

export const IconCalculateNow = makeIcon(
  <>
    <rect x="6" y="3" width="12" height="18" rx="1.5" />
    <path d="M6 8h12" />
    <rect x="9" y="11" width="2.2" height="2.2" />
    <rect x="12.8" y="11" width="2.2" height="2.2" />
    <rect x="9" y="14.6" width="2.2" height="2.2" />
    <rect x="12.8" y="14.6" width="2.2" height="2.2" />
    <path d="M9 18.5h6" />
  </>,
);

export const IconCalculateSheet = makeIcon(
  <>
    <rect x="6" y="3" width="12" height="18" rx="1.5" />
    <path d="M6 8h12" />
    <path d="M14 11.5H9.5l3 3-3 3H14" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

export const IconGetData = makeIcon(
  <>
    <ellipse cx="12" cy="6" rx="7" ry="2.8" />
    <path d="M5 6v12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V6" />
    <path d="M5 12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8" />
    <path d="M12 13.5V18" />
    <path d="M9.5 15.8 12 18l2.5-2.2" />
  </>,
);

export const IconFromWeb = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16" />
    <path d="M12 4c2.8 2.3 4 5 4 8s-1.2 5.7-4 8c-2.8-2.3-4-5-4-8s1.2-5.7 4-8z" />
  </>,
);

export const IconFromTextCsv = makeIcon(
  <>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M9 12h6" />
    <path d="M9 15.5h6" />
    <path d="M9 19h4" />
  </>,
);

export const IconRefresh = makeIcon(
  <>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 3.5V8h-4.5" />
  </>,
);

export const IconRefreshAll = makeIcon(
  <>
    <path d="M20 8A8 8 0 0 0 4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 16a8 8 0 0 0 16 0" />
    <path d="M20 20v-4h-4" />
  </>,
);

export const IconQueriesPane = makeIcon(
  <>
    <path d="M4 5.5h9" />
    <path d="M4 10.5h9" />
    <path d="M4 15.5h5" />
    <ellipse cx="17.5" cy="15.5" rx="3.5" ry="1.8" />
    <path d="M14 15.5v-6c0-1 1.6-1.8 3.5-1.8s3.5.8 3.5 1.8v6" />
  </>,
);

export const IconDataValidation = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M8 12.5l2.5 2.5L16 9.5" />
  </>,
);

export const IconRemoveDuplicates = makeIcon(
  <>
    <path d="M10 3h6l4 4v4" />
    <path d="M16 3v4h4" />
    <path d="M4 9h6l4 4v8H4z" />
    <path d="M10 9v4h4" />
    <circle cx="17.5" cy="17.5" r="3.5" />
    <path d="M15.8 17.5h3.4" />
  </>,
);

export const IconTextToColumns = makeIcon(
  <>
    <path d="M3 6h7" />
    <path d="M3 12h7" />
    <path d="M3 18h7" />
    <path d="M12 4v16" />
    <path d="M15 10l3 2-3 2" />
    <path d="M21 10l-3 2 3 2" />
  </>,
);

export const IconFlashFill = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="1" />
    <path d="M13 6l-5 7h4l-1 5 5-7h-4z" />
  </>,
);

export const IconConsolidate = makeIcon(
  <>
    <rect x="9" y="15" width="6" height="6" />
    <path d="M12 3v9" />
    <path d="M9.5 9.5 12 12l2.5-2.5" />
    <path d="M5 5.5l3.5 5" />
    <path d="M19 5.5l-3.5 5" />
  </>,
);

export const IconForecastSheet = makeIcon(
  <>
    <path d="M4 20h16" />
    <path d="M6 16l4-5 3 3 5-7" />
    <path d="M15 7h3v3" />
  </>,
);

export const IconWhatIf = makeIcon(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="12" r="2.5" />
    <path d="M8.2 7.2l7.3 3.4" />
    <path d="M8.2 16.8l7.3-3.4" />
  </>,
);

export const IconSolver = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </>,
);

export const IconGroup = makeIcon(
  <>
    <path d="M7 4c-2 0-2 2-2 4v3l-1.5 1L5 13v3c0 2 0 4 2 4" />
    <path d="M17 4c2 0 2 2 2 4v3l1.5 1L19 13v3c0 2 0 4-2 4" />
    <path d="M10 9h4" />
    <path d="M10 12h4" />
    <path d="M10 15h4" />
  </>,
);

export const IconUngroup = makeIcon(
  <>
    <path d="M7 4c-2 0-2 2-2 4v8c0 2 0 4 2 4" />
    <path d="M17 4c2 0 2 2 2 4v8c0 2 0 4-2 4" />
    <path d="M11.2 9v6" />
    <path d="M12.8 9v6" />
  </>,
);

export const IconSubtotal = makeIcon(
  <>
    <path d="M4 6h16" />
    <path d="M4 11h16" />
    <path d="M16 14H9l3.5 3.5L9 21h7" />
  </>,
);

export const IconShowDetail = makeIcon(
  <>
    <path d="M9 4H5a1 1 0 0 0-1 1v4" />
    <path d="M15 4h4a1 1 0 0 1 1 1v4" />
    <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    <path d="M9 20H5a1 1 0 0 0-1-1v-4" />
  </>,
);

export const IconHideDetail = makeIcon(
  <>
    <path d="M4 9V5a1 1 0 0 1 1-1h4" />
    <path d="M15 4h4a1 1 0 0 1 1 1v4" />
    <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    <path d="M9 20H5a1 1 0 0 0-1-1v-4" />
  </>,
);

export const IconEtlPipeline = makeIcon(
  <>
    <ellipse cx="7" cy="8" rx="4" ry="1.8" />
    <path d="M3 8v8c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V8" />
    <path d="M11 12h5" />
    <path d="M14 9.8 16.2 12 14 14.2" />
    <rect x="16" y="9" width="5" height="6" />
  </>,
);

export const IconSmartChip = makeIcon(
  <>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" />
  </>,
);

export const IconDataType = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <text x="7.5" y="16" fontSize="10" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A1
    </text>
  </>,
);

export const IconExternalLink = makeIcon(
  <>
    <path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
  </>,
);

export const IconRecentSources = makeIcon(
  <>
    <circle cx="9" cy="12" r="6" />
    <path d="M9 8.5V12l2.5 1.5" />
    <path d="M16.5 6H21" />
    <path d="M16.5 10.5H21" />
    <path d="M16.5 15H21" />
    <path d="M16.5 19.5H21" />
  </>,
);

export const IconExistingConnections = makeIcon(
  <>
    <circle cx="7" cy="7" r="2.5" />
    <circle cx="17" cy="7" r="2.5" />
    <circle cx="12" cy="17" r="2.5" />
    <path d="M8.8 9l2 5.5" />
    <path d="M15.2 9l-2 5.5" />
    <path d="M9.5 7h5" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */

export const IconSpelling = makeIcon(
  <>
    <text x="4" y="15" fontSize="10" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      ABC
    </text>
    <path d="M14 17.5l2.5 2.5L21 14.5" />
  </>,
);

export const IconThesaurus = makeIcon(
  <>
    <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
    <path d="M4 19a2 2 0 0 1 2-2h13" />
  </>,
);

export const IconAccessibility = makeIcon(
  <>
    <circle cx="12" cy="5" r="2.2" />
    <path d="M4 9.5c2.7.8 5.3 1.2 8 1.2s5.3-.4 8-1.2" />
    <path d="M12 11v5l-3 5" />
    <path d="M12 16l3 5" />
  </>,
);

export const IconTranslate = makeIcon(
  <>
    <path d="M4 6h9" />
    <path d="M8.5 4v2c0 3-2 5.5-4.5 7" />
    <path d="M6 10c1 2.5 3 4.5 5.5 5.5" />
    <path d="M13 20l4-9 4 9" />
    <path d="M14.5 16.5h5" />
  </>,
);

export const IconNewComment = makeIcon(
  <>
    <path d="M4 5h16v10H9l-5 4z" />
    <path d="M17 8v6" />
    <path d="M14 11h6" />
  </>,
);

export const IconPrevComment = makeIcon(
  <>
    <path d="M4 9h13v8H9l-4 3.2z" />
    <path d="M14 6V2.5" />
    <path d="M12.5 4 14 2.5 15.5 4" />
  </>,
);

export const IconNextComment = makeIcon(
  <>
    <path d="M4 4h13v8H9l-4 3.2z" />
    <path d="M14 15v3.5" />
    <path d="M12.5 17 14 18.5 15.5 17" />
  </>,
);

export const IconDeleteComment = makeIcon(
  <>
    <path d="M3 4h14v9H8l-4 3.5z" />
    <circle cx="18" cy="18" r="3.2" />
    <path d="M16.4 16.4l3.2 3.2" />
    <path d="M19.6 16.4l-3.2 3.2" />
  </>,
);

export const IconShowComments = makeIcon(
  <>
    <path d="M3 5h13v8H8l-4 3z" />
    <path d="M9 12h12v7h-7l-3 2.5z" />
  </>,
);

export const IconClearComments = makeIcon(
  <>
    <path d="M4 4h16v11H9l-5 4z" />
    <path d="M8 9h8" />
    <path d="M8 12.5h5" />
    <circle cx="18" cy="18" r="3.5" />
    <path d="M16.5 16.5l3 3" />
    <path d="M19.5 16.5l-3 3" />
  </>,
);

export const IconClearHyperlinks = makeIcon(
  <>
    <path d="M10 14a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.6-5.6l-1.7 1.7" />
    <path d="M14 10a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.6 5.6l1.7-1.7" />
    <circle cx="18" cy="18" r="3.5" />
    <path d="M16.5 16.5l3 3" />
    <path d="M19.5 16.5l-3 3" />
  </>,
);

export const IconNewNote = makeIcon(
  <>
    <path d="M5 3h11l4 4v14H5z" />
    <path d="M16 3v4h4" />
    <path d="M12 12v6" />
    <path d="M9 15h6" />
  </>,
);

export const IconProtectSheet = makeIcon(
  <>
    <rect x="4" y="3" width="12" height="18" rx="1" />
    <path d="M4 8h12" />
    <path d="M4 12.5h12" />
    <rect x="13.5" y="12" width="7.5" height="8" rx="1.5" />
    <path d="M15.2 12v-1.8a2.1 2.1 0 0 1 4.2 0V12" />
  </>,
);

export const IconProtectWorkbook = makeIcon(
  <>
    <path d="M5 3h10a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2z" />
    <rect x="14" y="13.5" width="6.5" height="7" rx="1.5" />
    <path d="M15.8 13.5v-1.5a1.6 1.6 0 0 1 3.2 0v1.5" />
  </>,
);

export const IconAllowEditRanges = makeIcon(
  <>
    <rect x="3" y="4" width="18" height="16" />
    <path d="M3 12h18" />
    <path d="M14 19l5-5 1.8 1.8-5 5H14z" />
  </>,
);

export const IconShowChanges = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7v5l3.5 2" />
  </>,
);

export const IconRevisionHistory = makeIcon(
  <>
    <circle cx="11" cy="13" r="6" />
    <path d="M11 9.5V13l2.5 1.5" />
    <path d="M17.5 10h4" />
    <path d="M17.5 14h4" />
    <path d="M17.5 18h3" />
  </>,
);

export const IconSensitivity = makeIcon(
  <>
    <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />
    <path d="M9 12l2 2 4-4" />
  </>,
);

export const IconCollaboration = makeIcon(
  <>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19c.7-3 2.9-4.8 5.5-4.8s4.8 1.8 5.5 4.8" />
    <circle cx="16.5" cy="9" r="2.5" />
    <path d="M15.5 14.5c2.3.3 4 1.9 4.6 4.2" />
  </>,
);

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export const IconZoomIn = makeIcon(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="M15.8 15.8 20 20" />
    <path d="M11 8.5v5" />
    <path d="M8.5 11h5" />
  </>,
);

export const IconZoomOut = makeIcon(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="M15.8 15.8 20 20" />
    <path d="M8.5 11h5" />
  </>,
);

export const IconZoomDialog = makeIcon(
  <>
    <circle cx="10" cy="10" r="5.5" />
    <path d="M14 14l4.5 4.5" />
    <text x="14" y="22" fontSize="9" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      %
    </text>
  </>,
);

export const IconZoomToSelection = makeIcon(
  <>
    <path d="M4 9V5a1 1 0 0 1 1-1h4" />
    <path d="M15 4h4a1 1 0 0 1 1 1v4" />
    <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    <path d="M9 20H5a1 1 0 0 0-1-1v-4" />
    <path d="M12 9.5v5" />
    <path d="M9.5 12h5" />
  </>,
);

export const IconZoom100 = makeIcon(
  <>
    <circle cx="9" cy="10" r="5.5" />
    <path d="M13 13.8l4 4" />
    <text x="13" y="22" fontSize="7.5" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      100%
    </text>
  </>,
);

export const IconPageBreakPreview = makeIcon(
  <>
    <rect x="3" y="5" width="8" height="14" />
    <rect x="13" y="5" width="8" height="14" />
    <path d="M3 12h18" strokeDasharray="3 2" />
  </>,
);

export const IconPageLayoutView = makeIcon(
  <>
    <rect x="6" y="5" width="12" height="16" />
    <path d="M6 9h12" />
    <path d="M9 13h6" />
    <path d="M9 16h6" />
    <path d="M4 3h16" />
    <path d="M6 3v1.5" />
    <path d="M9 3v1.5" />
    <path d="M12 3v1.5" />
    <path d="M15 3v1.5" />
    <path d="M18 3v1.5" />
  </>,
);

export const IconNormalView = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M4 9.3h16" />
    <path d="M4 14.6h16" />
    <path d="M9.3 4v16" />
    <path d="M14.6 4v16" />
  </>,
);

export const IconGridlines = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M4 9.3h16" strokeDasharray="2.5 2" />
    <path d="M4 14.6h16" strokeDasharray="2.5 2" />
    <path d="M9.3 4v16" strokeDasharray="2.5 2" />
    <path d="M14.6 4v16" strokeDasharray="2.5 2" />
  </>,
);

export const IconHeadings = makeIcon(
  <>
    <text x="6" y="9" fontSize="7" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      A B C
    </text>
    <text x="3" y="16" fontSize="7" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      1
    </text>
    <text x="3" y="22" fontSize="7" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      2
    </text>
    <rect x="7" y="11" width="14" height="9" />
  </>,
);

export const IconFormulaBar = makeIcon(
  <>
    <rect x="3" y="9" width="18" height="7" rx="1" />
    <text x="6" y="14.8" fontSize="8" fontStyle="italic" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      fx
    </text>
    <path d="M13 12.5h6" />
  </>,
);

export const IconSplit = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M4 10h16" />
    <path d="M10 4v16" />
  </>,
);

export const IconFreezePanes = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M4 10h16" />
    <path d="M10 4v16" />
    <path d="M15 14.8v4.4" />
    <path d="M13.1 15.9l3.8 2.2" />
    <path d="M16.9 15.9l-3.8 2.2" />
  </>,
);

export const IconFreezeTopRow = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M4 9h16" />
    <path d="M15 5v4" />
    <path d="M13.5 6l3 2" />
    <path d="M16.5 6l-3 2" />
  </>,
);

export const IconFreezeFirstColumn = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M9 4v16" />
    <path d="M6.5 10v4" />
    <path d="M5 11l3 2" />
    <path d="M8 11l-3 2" />
  </>,
);

export const IconFreezeSelection = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M12 9.5v5" />
    <path d="M9.5 12h5" />
    <path d="M4 15h4" />
    <path d="M16 15h4" />
  </>,
);

export const IconFullScreen = makeIcon(
  <>
    <path d="M4 9V4h5" />
    <path d="M15 4h5v5" />
    <path d="M20 15v5h-5" />
    <path d="M9 20H4v-5" />
  </>,
);

export const IconFocusCell = makeIcon(
  <>
    <rect x="8" y="8" width="8" height="8" />
    <path d="M12 2v4" />
    <path d="M12 18v4" />
    <path d="M2 12h4" />
    <path d="M18 12h4" />
  </>,
);

export const IconViewMacros = makeIcon(
  <>
    <path d="M9 8l-4.5 4L9 16" />
    <path d="M15 8l4.5 4L15 16" />
    <path d="M13 5l-2 14" />
  </>,
);

export const IconRecordMacro = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.5" fill="#C00000" stroke="none" />
  </>,
);

export const IconMacroSecurity = makeIcon(
  <>
    <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />
    <path d="M10 10l-2 2 2 2" />
    <path d="M14 10l2 2-2 2" />
  </>,
);

export const IconAppsScript = makeIcon(
  <>
    <rect x="6" y="4" width="12" height="16" rx="1.5" />
    <path d="M9.5 10.5l-1.8 1.5 1.8 1.5" />
    <path d="M14.5 10.5l1.8 1.5-1.8 1.5" />
    <path d="M12.8 9.5l-1.6 5" />
  </>,
);

export const IconAddons = makeIcon(
  <>
    <path d="M10 4h4c1.1 0 2 .9 2 2v1h2.5c1.1 0 2 .9 2 2v3c0 .6-.4 1-1 1h-3.6l-.5-.1c-.3-.1-.6.1-.6.4l.4 2.7c.1.6-.4 1-1 1H10c-1.1 0-2-.9-2-2v-1.5H6c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2h2V6c0-1.1.9-2 2-2z" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Help / File / Share                                                 */
/* ------------------------------------------------------------------ */

export const IconHelp = makeIcon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <text x="9.3" y="16.5" fontSize="11" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      ?
    </text>
  </>,
);

export const IconWhatsNew = makeIcon(
  <>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
  </>,
);

export const IconFeedback = makeIcon(
  <>
    <path d="M4 5h16v10H9l-5 4z" />
    <circle cx="8.5" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="10" r="1" fill="currentColor" stroke="none" />
  </>,
);

export const IconAbout = makeIcon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </>,
);

export const IconShare = makeIcon(
  <>
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="17.5" cy="5.5" r="2.5" />
    <circle cx="17.5" cy="18.5" r="2.5" />
    <path d="M8.3 10.8l6.9-3.9" />
    <path d="M8.3 13.2l6.9 3.9" />
  </>,
);

export const IconSave = makeIcon(
  <>
    <path d="M5 3h11l5 5v13H5z" />
    <path d="M8 3v5h7V3" />
    <rect x="8" y="13" width="8" height="8" />
  </>,
);

export const IconSaveAs = makeIcon(
  <>
    <path d="M4 4h10l5 5v11H4z" />
    <path d="M7.5 4v4.5h6V4" />
    <rect x="7.5" y="13" width="6" height="7" />
    <path d="M15 14.5l5 5-1.5 1.5-5-5z" />
  </>,
);

export const IconSaveEncrypted = makeIcon(
  <>
    <path d="M5 3h11l5 5v13H5z" />
    <path d="M8 3v5h7V3" />
    <rect x="9" y="12.5" width="6" height="6.5" rx="1.2" />
    <path d="M10.5 12.5v-1.5a1.5 1.5 0 0 1 3 0v1.5" />
  </>,
);

export const IconOpenFile = makeIcon(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
);

export const IconOpenDataSource = makeIcon(
  <>
    <ellipse cx="10" cy="8" rx="6" ry="2.4" />
    <path d="M4 8v9c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V8" />
    <path d="M4 12.5c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4" />
    <circle cx="18" cy="17.5" r="3.4" />
    <path d="M18 15.8v3.4" />
    <path d="M16.3 17.5h3.4" />
  </>,
);

export const IconNewWorkbook = makeIcon(
  <>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M12 12v6" />
    <path d="M9 15h6" />
  </>,
);

export const IconNewSheet = makeIcon(
  <>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M6 11h12" />
    <circle cx="17.5" cy="17.5" r="3.5" />
    <path d="M17.5 15.8v3.4" />
    <path d="M15.8 17.5h3.4" />
  </>,
);

export const IconDeleteSheet = makeIcon(
  <>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M6 11h12" />
    <circle cx="17.5" cy="17.5" r="3.5" />
    <path d="M16.2 16.2l2.6 2.6" />
    <path d="M18.8 16.2l-2.6 2.6" />
  </>,
);

export const IconPrint = makeIcon(
  <>
    <path d="M7 8V3h10v5" />
    <rect x="4" y="8" width="16" height="9" rx="1.5" />
    <rect x="7" y="13" width="10" height="8" />
    <circle cx="17.2" cy="11" r="0.9" fill="currentColor" stroke="none" />
  </>,
);

export const IconPrintPreview = makeIcon(
  <>
    <rect x="6" y="3" width="12" height="18" rx="1" />
    <path d="M9 7h6" />
    <circle cx="15.5" cy="15" r="3.5" />
    <path d="M18 17.5l3 3" />
  </>,
);

export const IconClose = makeIcon(
  <>
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </>,
);

export const IconOptions = makeIcon(
  <>
    <g>
      <rect x="10.8" y="3" width="2.4" height="18" rx="1" />
      <rect x="10.8" y="3" width="2.4" height="18" rx="1" transform="rotate(45 12 12)" />
      <rect x="10.8" y="3" width="2.4" height="18" rx="1" transform="rotate(90 12 12)" />
      <rect x="10.8" y="3" width="2.4" height="18" rx="1" transform="rotate(135 12 12)" />
    </g>
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1.8" />
  </>,
);

/* ------------------------------------------------------------------ */
/* Extras: app/report builders and misc ribbon buttons                 */
/* ------------------------------------------------------------------ */

export const IconBuildApp = makeIcon(
  <>
    <rect x="4" y="4" width="10" height="10" />
    <path d="M4 9h10" />
    <path d="M9 4v10" />
    <path d="M17 4l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" />
    <path d="M19.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </>,
);

export const IconNewReport = makeIcon(
  <>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M9 17v-4" />
    <path d="M12 17v-6" />
    <path d="M15 17v-3" />
  </>,
);

export const IconReports = makeIcon(
  <>
    <path d="M4 20h16" />
    <path d="M7 20v-5" />
    <path d="M11 20v-9" />
    <path d="M15 20v-6" />
    <path d="M19 20v-3" />
  </>,
);

export const IconMoreFunctions = makeIcon(
  <>
    <text x="4" y="17" fontSize="12" fontStyle="italic" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      fx
    </text>
    <text x="14" y="17" fontSize="12" fill="currentColor" stroke="none" fontFamily={GLYPH_FONT}>
      …
    </text>
  </>,
);

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every icon in the library, keyed by the task's canonical icon name.
 * The key '3dMap' matches the requested name (identifiers can't start
 * with a digit, so the component is IconMap3d).
 */
export const ribbonIcons = {
  cut: IconCut,
  copy: IconCopy,
  paste: IconPaste,
  pasteSpecial: IconPasteSpecial,
  formatPainter: IconFormatPainter,
  bold: IconBold,
  italic: IconItalic,
  underline: IconUnderline,
  doubleUnderline: IconDoubleUnderline,
  strikethrough: IconStrikethrough,
  fontColor: IconFontColor,
  fillColor: IconFillColor,
  borders: IconBorders,
  drawBorders: IconDrawBorders,
  fontGrow: IconFontGrow,
  fontShrink: IconFontShrink,
  alignLeft: IconAlignLeft,
  alignCenter: IconAlignCenter,
  alignRight: IconAlignRight,
  justify: IconJustify,
  alignTop: IconAlignTop,
  alignMiddle: IconAlignMiddle,
  alignBottom: IconAlignBottom,
  wrapText: IconWrapText,
  indentIncrease: IconIndentIncrease,
  indentDecrease: IconIndentDecrease,
  orientation: IconOrientation,
  mergeCenter: IconMergeCenter,
  merge: IconMerge,
  unmerge: IconUnmerge,
  percent: IconPercent,
  comma: IconComma,
  accounting: IconAccounting,
  increaseDecimal: IconIncreaseDecimal,
  decreaseDecimal: IconDecreaseDecimal,
  conditionalFormatting: IconConditionalFormatting,
  cellStyles: IconCellStyles,
  formatAsTable: IconFormatAsTable,
  manageRules: IconManageRules,
  newRule: IconNewRule,
  insertRow: IconInsertRow,
  insertColumn: IconInsertColumn,
  deleteRow: IconDeleteRow,
  deleteColumn: IconDeleteColumn,
  rowHeight: IconRowHeight,
  colWidth: IconColWidth,
  autofitRow: IconAutofitRow,
  autofitCol: IconAutofitCol,
  formatCells: IconFormatCells,
  moveOrCopySheet: IconMoveOrCopySheet,
  hideRow: IconHideRow,
  hideColumn: IconHideColumn,
  hideUnhide: IconHideUnhide,
  renameSheet: IconRenameSheet,
  autoSum: IconAutoSum,
  fill: IconFill,
  fillDown: IconFillDown,
  fillUp: IconFillUp,
  fillRight: IconFillRight,
  fillLeft: IconFillLeft,
  fillSeries: IconFillSeries,
  clear: IconClear,
  undo: IconUndo,
  redo: IconRedo,
  sortAsc: IconSortAsc,
  sortDesc: IconSortDesc,
  customSort: IconCustomSort,
  sortFilter: IconSortFilter,
  filter: IconFilter,
  reapplyFilter: IconReapplyFilter,
  advancedFilter: IconAdvancedFilter,
  find: IconFind,
  replace: IconReplace,
  goTo: IconGoTo,
  goToSpecial: IconGoToSpecial,
  selectObjects: IconSelectObjects,
  table: IconTable,
  pivotTable: IconPivotTable,
  recommendedPivot: IconRecommendedPivot,
  pivotChart: IconPivotChart,
  recommendedChart: IconRecommendedChart,
  picture: IconPicture,
  shapes: IconShapes,
  icons: IconIcons,
  smartArt: IconSmartArt,
  screenshot: IconScreenshot,
  mapChart: IconMapChart,
  '3dMap': IconMap3d,
  chartLine: IconChartLine,
  chartColumn: IconChartColumn,
  chartPie: IconChartPie,
  insertChart: IconInsertChart,
  sparkline: IconSparkline,
  removeSparkline: IconRemoveSparkline,
  slicer: IconSlicer,
  timeline: IconTimeline,
  hyperlink: IconHyperlink,
  link: IconLink,
  unlink: IconUnlink,
  textBox: IconTextBox,
  headerFooter: IconHeaderFooter,
  wordArt: IconWordArt,
  signatureLine: IconSignatureLine,
  object: IconObject,
  equation: IconEquation,
  symbol: IconSymbol,
  formControls: IconFormControls,
  pen: IconPen,
  highlighter: IconHighlighter,
  eraser: IconEraser,
  ruler: IconRuler,
  inkToText: IconInkToText,
  lasso: IconLasso,
  themes: IconThemes,
  margins: IconMargins,
  pageOrientation: IconPageOrientation,
  pageSize: IconPageSize,
  printArea: IconPrintArea,
  pageBreaks: IconPageBreaks,
  printTitles: IconPrintTitles,
  scaleToFit: IconScaleToFit,
  bringForward: IconBringForward,
  sendBackward: IconSendBackward,
  selectionPane: IconSelectionPane,
  insertFunction: IconInsertFunction,
  defineName: IconDefineName,
  nameManager: IconNameManager,
  useInFormula: IconUseInFormula,
  applyNames: IconApplyNames,
  createFromSelection: IconCreateFromSelection,
  tracePrecedents: IconTracePrecedents,
  traceDependents: IconTraceDependents,
  removeArrows: IconRemoveArrows,
  showFormulas: IconShowFormulas,
  errorChecking: IconErrorChecking,
  evaluateFormula: IconEvaluateFormula,
  watchWindow: IconWatchWindow,
  calculateNow: IconCalculateNow,
  calculateSheet: IconCalculateSheet,
  getData: IconGetData,
  fromWeb: IconFromWeb,
  fromTextCsv: IconFromTextCsv,
  refresh: IconRefresh,
  refreshAll: IconRefreshAll,
  queriesPane: IconQueriesPane,
  dataValidation: IconDataValidation,
  removeDuplicates: IconRemoveDuplicates,
  textToColumns: IconTextToColumns,
  flashFill: IconFlashFill,
  consolidate: IconConsolidate,
  forecastSheet: IconForecastSheet,
  whatIf: IconWhatIf,
  solver: IconSolver,
  group: IconGroup,
  ungroup: IconUngroup,
  subtotal: IconSubtotal,
  showDetail: IconShowDetail,
  hideDetail: IconHideDetail,
  etlPipeline: IconEtlPipeline,
  smartChip: IconSmartChip,
  dataType: IconDataType,
  externalLink: IconExternalLink,
  recentSources: IconRecentSources,
  existingConnections: IconExistingConnections,
  spelling: IconSpelling,
  thesaurus: IconThesaurus,
  accessibility: IconAccessibility,
  translate: IconTranslate,
  newComment: IconNewComment,
  prevComment: IconPrevComment,
  nextComment: IconNextComment,
  deleteComment: IconDeleteComment,
  showComments: IconShowComments,
  clearComments: IconClearComments,
  clearHyperlinks: IconClearHyperlinks,
  newNote: IconNewNote,
  protectSheet: IconProtectSheet,
  protectWorkbook: IconProtectWorkbook,
  allowEditRanges: IconAllowEditRanges,
  showChanges: IconShowChanges,
  revisionHistory: IconRevisionHistory,
  sensitivity: IconSensitivity,
  collaboration: IconCollaboration,
  zoomIn: IconZoomIn,
  zoomOut: IconZoomOut,
  zoomDialog: IconZoomDialog,
  zoomToSelection: IconZoomToSelection,
  zoom100: IconZoom100,
  pageBreakPreview: IconPageBreakPreview,
  pageLayoutView: IconPageLayoutView,
  normalView: IconNormalView,
  gridlines: IconGridlines,
  headings: IconHeadings,
  formulaBar: IconFormulaBar,
  split: IconSplit,
  freezePanes: IconFreezePanes,
  freezeTopRow: IconFreezeTopRow,
  freezeFirstColumn: IconFreezeFirstColumn,
  freezeSelection: IconFreezeSelection,
  fullScreen: IconFullScreen,
  focusCell: IconFocusCell,
  viewMacros: IconViewMacros,
  recordMacro: IconRecordMacro,
  macroSecurity: IconMacroSecurity,
  addons: IconAddons,
  help: IconHelp,
  whatsNew: IconWhatsNew,
  feedback: IconFeedback,
  about: IconAbout,
  share: IconShare,
  save: IconSave,
  saveAs: IconSaveAs,
  saveEncrypted: IconSaveEncrypted,
  openFile: IconOpenFile,
  openDataSource: IconOpenDataSource,
  newWorkbook: IconNewWorkbook,
  newSheet: IconNewSheet,
  deleteSheet: IconDeleteSheet,
  print: IconPrint,
  printPreview: IconPrintPreview,
  close: IconClose,
  options: IconOptions,
  buildApp: IconBuildApp,
  newReport: IconNewReport,
  reports: IconReports,
  moreFunctions: IconMoreFunctions,
} as const;

export type RibbonIconName = keyof typeof ribbonIcons;
