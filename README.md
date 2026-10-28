# Folio

A minimal PDF reader with a personal library, quiet colors, and room to focus. Runs locally in your browser.

![Folio library with shelves and reading progress](docs/screenshots/library.jpg)

## Features

- **Your library.** Import PDFs, link local files in supported browsers, and drag books between shelves. Keep track of what you’re reading and where you left off.
- **Comfortable reading.** Continuous scrolling, trackpad pinch to zoom, fit controls, editable page numbers, and chapters when available.
- **Find a passage.** Search the whole PDF and jump between highlighted results.
- **Keep what matters.** Yellow, green, and pink highlights, page bookmarks, and notes. Export passages as Markdown, plain text, or JSON.
- **Less on screen.** Focus mode, light and dark reading backgrounds, and subtle transitions that respect reduced motion.

<details>
<summary>Reader preview</summary>

![Folio reader with a minimal PDF search bar](docs/screenshots/reader.jpg)

</details>

## Run locally

Requires **Python 3** and a current browser. No build step or package installation.

```sh
git clone https://github.com/christianad11/folio.git
cd folio
python3 server.py
```

Folio opens at [127.0.0.1:4337](http://127.0.0.1:4337/). Keep the terminal open while reading; press `Ctrl+C` to stop. On macOS, you can also double-click **Start Folio.command**.

Everything needed to read PDFs is bundled, so Folio works offline after cloning. This version runs in a browser with a local server.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Search PDF | `⌘/Ctrl+F` |
| Next / previous search result | `Enter` / `Shift+Enter` |
| Focus mode | `F` |
| Chapters / saved passages | `C` / `S` |
| Bookmark page / save selected text | `B` / `H` |
| Zoom in / out | `+` / `−` |
| Close a panel or leave focus mode | `Esc` |

## Your data

PDFs, shelves, progress, and annotations stay in your browser’s IndexedDB. Use the same browser and address to return to your library. Clearing browser data removes it; export passages you want to keep. Linked originals remain on disk.

Search and text highlights require selectable PDF text; OCR is not included. Exports contain your passages and page references, rather than an annotated PDF.

## Typography

The previews use [Michelangelus by Microsoft](https://www.microsoft.com/en-us/download/details.aspx?id=108856) for titles. The font is not redistributed here. To use it locally, download it from Microsoft and place `Michelangelus-Regular.ttf` in `dist/assets/fonts/`. Folio uses a serif fallback otherwise.

## Source

Plain HTML, CSS, and JavaScript in `dist/`, served by Python’s standard library. PDF rendering uses bundled **Mozilla PDF.js 6.4.299**. See [third-party notices](THIRD_PARTY_NOTICES.md) for its licenses. The included sample PDF contains original Folio field notes.
