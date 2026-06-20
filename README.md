# PDF2Image

Convert PDF pages into PNG or JPEG images — entirely in your browser.

**100% client-side.** Your files are read locally via the browser's `FileReader` and rendered with [pdf.js](https://mozilla.github.io/pdf.js/). Nothing is ever uploaded — no server, no analytics, no external calls. The page works offline once loaded.

## Features

- Drag-and-drop or click to select a PDF (with validation).
- Renders every page to a canvas with a live thumbnail grid.
- Choose output format: **PNG** (lossless) or **JPEG** (with quality slider).
- Resolution / scale control (1×–3×) for higher-DPI output.
- Per-page **Download** button.
- **Download all as ZIP** — produces `<pdfname>-pages.zip` with zero-padded `page-001.png` … entries ([JSZip](https://stuk.github.io/jszip/)).
- Incremental rendering with a progress bar; the UI stays responsive on large PDFs.
- Graceful handling of corrupt and password-protected files.
- Responsive design for mobile and desktop.

## Usage

It's a static site — no build step. Either:

- Open `index.html` directly in a browser, **or**
- Serve the folder with any static host (`python3 -m http.server`, nginx, etc.) and visit it.

Then drop a PDF in, pick your format/resolution, and click **Convert pages**.

## Privacy

Files are processed locally in your browser and never leave your device. The only network activity is loading the page's own vendored JavaScript libraries (bundled in `vendor/`).

## Project layout

```
index.html      Markup + UI
style.css       Styling (dark, responsive)
app.js          All conversion logic (vanilla JS, no framework)
vendor/         Pinned, locally-bundled libraries:
                  pdf.min.js + pdf.worker.min.js  (pdf.js 3.11.174)
                  jszip.min.js                    (JSZip 3.10.1)
test/           Sample-PDF generator + headless verification script
```

## Development / verification

```bash
node --check app.js              # syntax
node test/make-sample-pdf.js     # writes test/sample.pdf
node test/verify.js              # headless-browser end-to-end checks
```

`test/verify.js` uses Puppeteer if available and points at a Chromium binary via
`CHROME_BIN`. See [test/verify.js](test/verify.js).

## License

MIT. Bundled libraries retain their own licenses (pdf.js — Apache-2.0; JSZip — MIT/GPLv3).
