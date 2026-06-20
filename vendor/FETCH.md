# Vendored libraries

These files are bundled locally so the app works offline and needs no CDN.
This build took the **vendored-locally** path (the container had network egress,
so the files were downloaded at build time rather than referenced via CDN).

| File | Library | Version | Source URL | SHA-256 |
|------|---------|---------|------------|---------|
| `pdf.min.js` | pdf.js | 3.11.174 | https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js | `5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946` |
| `pdf.worker.min.js` | pdf.js worker | 3.11.174 | https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js | `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b` |
| `jszip.min.js` | JSZip | 3.10.1 | https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js | `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e` |

## Why pdf.js 3.11.174 (not 4.x)

The 3.x line ships a **UMD** build that exposes `pdfjsLib` as a classic global
via `<script>`. That works when the page is opened directly from `file://`,
with no ES-module / CORS restrictions and no build step — matching the
"open index.html as a static file" constraint. pdf.js 4.x is ESM-first, which
fails to import over `file://` in Chromium without a server.

## Re-vendoring / integrity check

To re-download and verify these exact files:

```bash
cd vendor
curl -sS -o pdf.min.js        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
curl -sS -o pdf.worker.min.js "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
curl -sS -o jszip.min.js      "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"
sha256sum -c <<'EOF'
5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946  pdf.min.js
feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b  pdf.worker.min.js
acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e  jszip.min.js
EOF
```
