# Google Sheets feature inventory

Discovered October 13, 2026 by walking a live Google Sheet in the browser. Read-only pass, nothing changed or saved.

Two caveats. First, this was an anonymously shared sheet with no sign-in, so several items show as disabled and are marked [disabled] below. The disabled state is an artifact of anonymous mode, not a missing feature. Second, the cell right-click menu and the row-header right-click menu could not be captured (the browser tooling cannot right-click the grid canvas), so those two surfaces are intentionally absent rather than guessed.

## File

- New (submenu, disabled in anonymous mode)
- Open
- Import
- Make a copy
- Share (submenu, disabled)
- Email (submenu, disabled)
- Download (submenu): Microsoft Excel, OpenDocument, PDF, Web page, Comma-separated values, Tab-separated values
- Rename
- Move to trash
- Version history (submenu, disabled)
- Details
- Security limitations
- Settings
- Print

## Edit

- Undo (Ctrl+Z) [disabled], Redo (Ctrl+Y) [disabled]
- Cut (Ctrl+X), Copy (Ctrl+C), Paste (Ctrl+V)
- Paste special (submenu): Values only (Ctrl+Shift+V), Format only (Ctrl+Alt+V), Formula only, Conditional formatting only, Data validation only, Transposed, Column width only, All except borders
- Move (submenu) [disabled]
- Delete (submenu): Values, Row, Column, Cells and shift up, Cells and shift left, Notes
- Find and replace

## View

- Show (submenu): Formula bar (checked), Gridlines (checked), Formulas (Ctrl+backtick), Protected ranges
- Freeze (submenu): No rows, 1 row, 2 rows, Up to row 1, No columns, 1 column, 2 columns, Up to column A
- Group (submenu): Group, Ungroup [disabled]
- Comments (submenu): Hide comments (Ctrl+Alt+Shift+J), Minimize comments (checked; Ctrl+Alt+Shift+W and Ctrl+Alt+Shift+M), Show all comments (Ctrl+Alt+Shift+A)
- Hidden sheets (submenu) [disabled]
- Zoom (submenu): 50%, 75%, 90%, 100% (checked), 125%, 150%, 200%
- Full screen

## Insert

- Cells (submenu): Insert cells and shift right, Insert cells and shift down
- Rows (submenu): Insert 1 row above, Insert 1 row below
- Columns (submenu): Insert 1 column left, Insert 1 column right
- Sheet (Shift+F11)
- Pre-built tables [disabled]
- Chart, Pivot table
- Image (submenu) [disabled]
- Drawing
- Function (submenu): SUM, AVERAGE, COUNT, MAX, MIN, then All, Array, Database, Date, Engineering, Filter, Financial, Google, Info, Logical, Lookup, Math, Operator, Parser, Statistical, Text, Web (each a submenu), Learn more
- Link (Ctrl+K), Checkbox, Dropdown
- Emoji [disabled]
- Smart chips (submenu): People, File, Calendar events, Finance, Rating
- Comment (Ctrl+Alt+M), Note (Shift+F2)

### Full function catalog (Insert > Function > All)

ABS, ACCRINT, ACCRINTM, ACOS, ACOSH, ACOT, ACOTH, ADDRESS, ADD, AGGREGATE, AMORDEGRC, AMORLINC, AND, ARABIC, ARRAY_CONSTRAIN, ARRAYFORMULA, ARRAY_LITERAL, ASC, ASIN, ASINH, ATAN, ATAN2, ATANH, AVEDEV, AVERAGE, AVERAGEA, AVERAGEIF, AVERAGEIFS, AVERAGE.WEIGHTED, BASE, BESSELI, BESSELJ, BESSELK, BESSELY, BETA.DIST, BETA.INV, BETADIST, BETAINV, BIN2DEC, BIN2HEX, BIN2OCT, BINOM.DIST, BINOMDIST, BINOM.INV, BITAND, BITLSHIFT, BITOR, BITRSHIFT, BITXOR, BYCOL, BYROW, CEILING, CEILING.MATH, CEILING.PRECISE, CELL, CHAR, CHIDIST, CHIINV, CHISQ.DIST, CHISQ.DIST.RT, CHISQ.INV, CHISQ.INV.RT, CHISQ.TEST, CHITEST, CHOOSE, CHOOSECOLS, CHOOSEROWS, CLEAN, CODE, COLUMN, COLUMNS, COMBIN, COMBINA, COMPLEX, CONCAT, CONCATENATE, CONFIDENCE, CONFIDENCE.NORM, CONFIDENCE.T, CONVERT, CORREL, COS, COSH, COT, COTH, COUNT, COUNTA, COUNTBLANK, COUNTIF, COUNTIFS, COUNTUNIQUE, COUNTUNIQUEIFS, COUPDAYBS, COUPDAYS, COUPDAYSNC, COUPNCD, COUPNUM, COUPPCD, COVAR, COVARIANCE.P, COVARIANCE.S, CRITBINOM, CSC, CSCH, CUMIPMT, CUMPRINC, DATE, DATEDIF, DATEVALUE, DAVERAGE, DAY, DAYS, DAYS360, DB, DCOUNT, DCOUNTA, DDB, DEC2BIN, DEC2HEX, DEC2OCT, DECIMAL, DEGREES, DELTA, DETECTLANGUAGE, DEVSQ, DGET, DISC, DIVIDE, DMAX, DMIN, DOLLAR, DOLLARDE, DOLLARFR, DPRODUCT, DSTDEV, DSTDEVP, DSUM, DURATION, DVAR, DVARP, EDATE, EFFECT, ENCODEURL, EOMONTH, EQ, ERF, ERF.PRECISE, ERFC, ERFC.PRECISE, ERROR.TYPE, EVEN, EXACT, EXP, EXPAND, EXPON.DIST, EXPONDIST, F.DIST, F.DIST.RT, F.INV, F.INV.RT, F.TEST, FACT, FACTDOUBLE, FALSE, FDIST, FILTER, FINV, FISHER, FISHERINV, FLATTEN, FLOOR, FLOOR.MATH, FLOOR.PRECISE, FORECAST, FORECAST.ETS, FORECAST.ETS.CONFINT, FORECAST.ETS.SEASONALITY, FORECAST.ETS.STAT, FORECAST.LINEAR, FREQUENCY, FTEST, FV, FVSCHEDULE, GAMMA, GAMMA.DIST, GAMMA.INV, GAMMADIST, GAMMAINV, GAMMALN, GAMMALN.PRECISE, GAUSS, GCD, GEOMEAN, GESTEP, GETPIVOTDATA, GOOGLEFINANCE, GOOGLETRANSLATE, GROWTH, HARMEAN, HEX2BIN, HEX2DEC, HEX2OCT, HLOOKUP, HOUR, HYPERLINK, HYPGEOM.DIST, HYPGEOMDIST, IF, IFERROR, IFNA, IFS, IMAGE, IMPORTDATA, IMPORTFEED, IMPORTHTML, IMPORTRANGE, IMPORTXML, INDEX, INDIRECT, INFO, INT, INTERCEPT, IPMT, IRR, ISBETWEEN, ISBLANK, ISDATE, ISEMAIL, ISERR, ISERROR, ISEVEN, ISFORMULA, ISLOGICAL, ISNA, ISNONTEXT, ISNUMBER, ISO.CEILING, ISODD, ISOWEEKNUM, ISPMT, ISREF, ISTEXT, ISURL, JOIN, KURT, LAMBDA, LARGE, LCM, LCM_RANGE, LEFT, LEN, LENB, LET, LINEST, LN, LOG, LOG10, LOGEST, LOGINV, LOGNORM.DIST, LOGNORM.INV, LOGNORMDIST, LOWER, MAKEARRAY, MAP, MATCH, MAX, MAXA, MAXIFS, MDETERM, MDURATION, MEDIAN, MID, MIN, MINA, MINIFS, MINUTE, MINVERSE, MIRR, MMULT, MOD, MODE, MODE.MULT, MODE.SNGL, MONTH, MROUND, MULTINOMIAL, MUNIT, N, NA, NEGBINOM.DIST, NEGBINOMDIST, NETWORKDAYS, NETWORKDAYS.INTL, NOMINAL, NORM.DIST, NORM.INV, NORM.S.DIST, NORM.S.INV, NORMDIST, NORMINV, NORMSDIST, NORMSINV, NOT, NOW, NPER, NPV, OCT2BIN, OCT2DEC, OCT2HEX, ODD, OFFSET, OR, PDURATION, PEARSON, PERCENTILE, PERCENTILE.EXC, PERCENTILE.INC, PERCENTRANK, PERCENTRANK.EXC, PERCENTRANK.INC, PERMUT, PERMUTATIONA, PHI, PI, PMT, POISSON, POISSON.DIST, POWER, PPMT, PRICE, PRICEDISC, PRICEMAT, PROB, PRODUCT, PROPER, PV, QUARTILE, QUARTILE.EXC, QUARTILE.INC, QUERY, QUOTIENT, RADIANS, RAND, RANDARRAY, RANDBETWEEN, RANK, RANK.AVG, RANK.EQ, RATE, RECEIVED, REDUCE, REGEXEXTRACT, REGEXMATCH, REGEXREPLACE, REPLACE, REPT, RIGHT, ROMAN, ROUND, ROUNDDOWN, ROUNDUP, ROW, ROWS, RRI, RSQ, SCAN, SEARCH, SEC, SECH, SECOND, SEQUENCE, SERIESSUM, SHEET, SHEETS, SIGN, SIN, SINH, SKEW, SKEW.P, SLN, SLOPE, SMALL, SORT, SORTN, SPLIT, SQRT, SQRTPI, STANDARDIZE, STDEV, STDEV.P, STDEV.S, STDEVA, STDEVP, STDEVPA, STEYX, SUBSTITUTE, SUBTOTAL, SUM, SUMIF, SUMIFS, SUMPRODUCT, SUMSQ, SUMX2MY2, SUMX2PY2, SUMXMY2, SWITCH, SYD, T, TAN, TANH, TBILLEQ, TBILLPRICE, TBILLYIELD, TEXT, TEXTAFTER, TEXTBEFORE, TEXTJOIN, TIME, TIMEVALUE, TODAY, TOROW, TOCOL, TRANSPOSE, TREND, TRIM, TRIMMEAN, TRIMRANGE, TRUE, TRUNC, TTEST, TYPE, UNICHAR, UNICODE, UNIQUE, UPPER, VARA, VARPA, VDB, VLOOKUP, WEEKDAY, WEEKNUM, WEIBULL, WEIBULL.DIST, WORKDAY, WORKDAY.INTL, WRAPCOLS, WRAPROWS, XIRR, XLOOKUP, XMATCH, XNPV, XOR, YEAR, YEARFRAC, YIELD, YIELDDISC, YIELDMAT, ZTEST

The named category submenus (Array, Database, Date and so on) group subsets of the above.

## Format

- Theme
- Number (submenu): Automatic (checked), Plain text, Number (1,000.12), Percent (10.12%), Scientific (1.01E+03), Accounting, Financial, Currency, Currency rounded, Date (26/09/2008), Time (15:59:00), Date time (26/09/2008 15:59:00), Duration (24:01:00), Custom currency, Custom date and time, Custom number format
- Text (submenu): Bold (Ctrl+B), Italic (Ctrl+I), Underline (Ctrl+U), Strikethrough (Alt+Shift+5)
- Alignment (submenu): Left (Ctrl+Shift+L), Center (Ctrl+Shift+E), Right (Ctrl+Shift+R), Top, Middle, Bottom
- Wrapping (submenu): Overflow, Wrap, Clip
- Rotation (submenu): None, Tilt up, Tilt down, Stack vertically, Rotate up, Rotate down, Custom angle (submenu): -90, -75, -60, -45, -30, -15, 0 (checked), 15, 30, 45, 60, 75, 90 degrees
- Smart chips (submenu): People chips (submenu): Default (checked), Last name First name, Email address
- Font size (submenu): 6, 7, 8, 9, 10 (checked), 11, 12, 14, 18, 24, 36
- Merge cells (submenu) [disabled]
- Convert to table (Ctrl+Alt+T) [disabled]
- Conditional formatting
- Alternating colors
- Clear formatting (Ctrl+\)

## Data

- Sort sheet (submenu): Sort sheet by column A (A to Z), Sort sheet by column A (Z to A)
- Sort range (submenu) [disabled]
- Create a filter
- Create group by view (submenu): Column A
- Create filter view, Add a slicer, Protect sheets and ranges, Named ranges, Named functions
- Randomize range [disabled]
- Column stats, Data validation
- Data cleanup (submenu): Cleanup suggestions [disabled], Remove duplicates, Trim whitespace
- Split text to columns, Data extraction
- Data connectors (submenu) [disabled]

## Tools

- Spelling (submenu): Spell check, Personal dictionary [disabled]
- Suggestion controls (submenu): Enable autocomplete (checked), Enable formula suggestions (checked), Enable formula corrections (checked), Enable named functions suggestions (checked), Enable dropdown chip suggestions (checked), Enable smart people chip suggestions (checked)
- Calculation controls (submenu): Automatic (checked), Manual
- Notification settings (submenu): Edit notifications [disabled]
- Accessibility

## Extensions

- Add-ons (submenu): Get add-ons, Manage add-ons, View document add-ons [disabled]
- Macros (submenu): Record macro, Import macro [disabled], Manage macros [disabled]
- Apps Script
- AppSheet (submenu): Create an app [disabled], View sample apps, Learn how to create apps
- Data Studio (submenu): Create a report [disabled], View sample reports, Learn how to create report

## Help

- Search the menus (Alt+/), Sheets Help, Training, Updates, Help Sheets improve, Report abuse, Privacy Policy, Terms of Service, Function list, Keyboard shortcuts (Ctrl+/)

## Column header context menu

Captured through the column header dropdown arrow, which opens the same menu as right-click.

- Cut (Ctrl+X), Copy (Ctrl+C), Paste (Ctrl+V)
- Paste special (submenu): Values only (Ctrl+Shift+V), Format only (Ctrl+Alt+V), Formula only, Conditional formatting only, Data validation only, Transposed, Column width only, All except borders
- Insert 1 column left, Insert 1 column right
- Delete column, Clear column, Hide column, Resize column
- Create a filter
- Sort sheet A to Z, Sort sheet Z to A
- Conditional formatting, Data validation, Column stats, Dropdown
- Smart chips (submenu): People, File, Calendar events, Finance, Rating
- View more column actions (submenu): Freeze up to column B, Group column, Get link to this range, Randomize range, Define named range, Protect range

## Sheet tab context menu

- Delete [disabled], Duplicate, Rename
- Change color (submenu): Reset button; grays row (black through white in 10 steps); color rows (red berry, red, orange, yellow, green, cyan, cornflower blue, blue, purple, magenta, each with light and dark variants); STANDARD theme colors (black, white, #4285f4 cornflower blue, #ea4335, #fbbc04, #34a853, #ff6d01, #46bdc6); CUSTOM section (Add a custom color, Pick a custom color)
- Hide sheet [disabled], View comments [disabled], Move right [disabled], Move left [disabled]

## Toolbar formatting controls (left to right)

- Undo (Ctrl+Z), Redo (Ctrl+Y), Print (Ctrl+P), Paint format
- Zoom combobox (50% to 200%, 100% selected)
- Format as currency, Format as percent, Decrease decimal places, Increase decimal places
- More formats ("123" button): opens the same Number-format list as Format > Number
- Font listbox, Default (Arial) selected. Full list: More fonts, then THEME section: Default (Arial) (checked), Amatic SC, Arial, Caveat, Comfortaa, Courier New, EB Garamond, Lexend, Lobster, Lora, Merriweather, Montserrat, Nunito, Oswald, Pacifico, Playfair Display, Roboto, Roboto Mono, Roboto Serif, Spectral, Times New Roman
- Decrease font size (Ctrl+Shift+comma), Font size combobox (6 through 36, 10 selected), Increase font size (Ctrl+Shift+period)
- Bold (Ctrl+B), Italic (Ctrl+I), Strikethrough (Alt+Shift+5)
- Text color: Reset; grays; red berry, red, orange, yellow, green, cyan, cornflower blue, blue, purple, magenta with light and dark variants; STANDARD theme colors; CUSTOM (Add a custom color, Pick a custom color); plus a Conditional formatting checkbox item
- Fill color: same palette as Text color
- Borders: All borders, Inner borders, Horizontal borders, Vertical borders, Outer borders; Left border, Top border, Right border, Bottom border, Clear borders; Border color (same palette); Border style (Thin border (checked), Medium border, Thick border, Dashed border, Dotted border, Double border)
- Merge cells [disabled], Select merge type [disabled]
- Horizontal align (Left selected, Center, Right), Vertical align (Top, Middle selected, Bottom), Text wrapping (Overflow selected, Wrap, Clip), Text rotation (None, Tilt up, Tilt down, Stack vertically, Rotate up, Rotate down, Custom angle combobox, 0 degrees selected)
- Insert link (Ctrl+K), Insert comment (Ctrl+Alt+M), Insert chart, Create a filter
- Filter views: Create group by view, Create filter view
- Functions: sum, average, count, max, min, then the same category submenus as Insert > Function (All, Array, Database through Web), Learn more (checkbox)
- Hide the menus (Ctrl+Shift+F)

## Other surfaces discovered

- Search the menus (Alt+/): a "Menus" search box in the toolbar that searches all menu commands.
- Keyboard shortcuts dialog (Help > Keyboard shortcuts, Ctrl+/): searchable dialog with sections for Editing, Menus, Formatting, Data, Review, Selection, Screen reader support, File commands, View, Navigation and Help, plus an "Enable compatible spreadsheet shortcuts" switch. Notably it lists a "Gemini menu (Alt+Shift+g)" and a "Context menu (Shift+right-click)" even though no Gemini item appears in the visible menu bar for anonymous users.
- Gemini side-panel button ("Gemini. To use, sign in.") present but requires sign-in. Calendar, Keep and Tasks side panels are not shown in the anonymous view.
- No Explore button visible in the anonymous shared view. Bottom-right shows only sheet tabs and scrollbars.
- Name box (Ctrl+J) with named-range dropdown; formula bar with fx.
- Sheet tab bar: Add Sheet (+), All Sheets list, Sheet1 tab.
- Banner area: "Show all comments" button; "Share. Anyone with the link..." status (disabled); "Quick sharing actions" (disabled).
- Hide the menus (Ctrl+Shift+F) collapses the menu bar.
- Menus show access-key underlines (for example File "F", Paste special "(v)") and checkmarks or radio marks for toggle states as noted above.
