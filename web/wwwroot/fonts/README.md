# Terminal view font

`ghul-terminal.woff2` is the face the output pane uses while it shows a
terminal screen: a subset of Noto Sans Mono CJK JP Regular 2.004, licensed
under the SIL Open Font License 1.1 (`OFL.txt`). The ordinary output pane
keeps Fira Code.

In it, every glyph is half an em wide, so text is a grid of equal columns:

| Range | What |
|---|---|
| U+0020–U+007E | ASCII |
| U+2500–U+257F | Box drawing |
| U+FF61–U+FF9F | Half-width katakana |

Noto Sans Mono CJK draws box drawing a full em wide. In this subset each of
those glyphs is narrowed to half an em by a piecewise-linear map of x (0–440
to 0–190, 440–560 shifted to 190–310, 560–1000 to 310–500), which keeps the
vertical strokes, all between 440 and 560, at their designed width. Layout
features and hinting are dropped, and the family is renamed `ghul terminal`.

The subset was made with fontTools from `NotoSansCJK-Regular.ttc` (face 5,
Noto Sans Mono CJK JP).
