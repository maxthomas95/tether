# Bundled terminal fonts

Iosevka Fixed 34.9.0 comes from the unmodified upstream webfont release:
https://github.com/be5invis/Iosevka/releases/tag/v34.9.0

The four WOFF2 files were extracted from `PkgWebFont-IosevkaFixed-34.9.0.zip`
and renamed to lowercase filenames. They retain the full upstream glyph set,
including terminal box drawing, and include regular, bold, italic, and bold
italic at the normal width. The Fixed family has ligatures disabled.

IBM Plex Mono 5.3.0 is provided by `@fontsource/ibm-plex-mono`, with the same
four styles imported by the renderer. Both font families use the SIL Open
Font License 1.1; their license texts ship in `public/licenses/`.

SHA-256 for the Iosevka files:

| File | SHA-256 |
| --- | --- |
| iosevka-fixed-regular.woff2 | 2b9363a0d6e7548349e670fb6af608f46c2ca5266e701a16c9c4138075ff3fb4 |
| iosevka-fixed-bold.woff2 | afedc79dcee6e71d365b6e9c5880cc21d007f4cdae8350dd08f5eee663126eb3 |
| iosevka-fixed-italic.woff2 | 99968c72ef82d72ec707233c81a81051916e50510e6c246d99d44757f9984790 |
| iosevka-fixed-bolditalic.woff2 | a9870887a54595f2a5f510a59ae9592263c9952c1b524cb62067afc16b59e6ad |
