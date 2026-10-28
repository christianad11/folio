# Third-party notices

Folio bundles Mozilla PDF.js **6.4.299** and its supporting assets for offline use. Original license files are retained with the assets.

| Component | License location |
| --- | --- |
| PDF.js | [Apache 2.0](dist/vendor/PDFJS-LICENSE) |
| PDF character maps | [CMap license](dist/vendor/cmaps/LICENSE) |
| Foxit standard fonts | [Foxit license](dist/vendor/standard_fonts/LICENSE_FOXIT) |
| Liberation standard fonts | [Liberation license](dist/vendor/standard_fonts/LICENSE_LIBERATION) |
| Image decoders and color management | `LICENSE_*` files in [dist/vendor/wasm/](dist/vendor/wasm/) |

Michelangelus is an optional, separately downloaded Microsoft font. Its files are excluded from this repository; the original license supplied with the download applies.

The desktop build bundles [Electron 45.1.0](https://github.com/electron/electron/tree/v45.1.0), available under the MIT license, together with Chromium, Node.js, and their third-party components. Electron’s runtime license and Chromium notices are retained in the generated app bundle. Build tools and their licenses are listed in `package-lock.json` and their installed packages.
