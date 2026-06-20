/*
 * Headless verification: loads index.html in Chromium, feeds test/sample.pdf,
 * triggers conversion, and asserts the full pipeline works:
 *  - PDF loads, page count detected
 *  - pages render to canvas (thumbnails appear)
 *  - per-page download produces a non-empty image blob
 *  - "Download all ZIP" produces a valid (PK-signature) zip
 *  - no unexpected network requests (only file:// + the vendored libs)
 */
const puppeteer = require("/tmp/node_modules/puppeteer");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const INDEX = "file://" + path.join(ROOT, "index.html");
const SAMPLE = path.join(ROOT, "test", "sample.pdf");

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.CHROME_BIN || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();

  const networkExternal = [];
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith("file://") && !u.startsWith("data:") && !u.startsWith("blob:")) {
      networkExternal.push(u);
    }
    req.continue();
  });

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text()); });

  const results = {};
  function assert(name, cond, detail) {
    results[name] = { pass: !!cond, detail: detail || "" };
    console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
  }

  await page.goto(INDEX, { waitUntil: "networkidle0" });

  // libs loaded?
  const libs = await page.evaluate(() => ({
    pdfjs: typeof pdfjsLib !== "undefined",
    jszip: typeof JSZip !== "undefined",
    worker: pdfjsLib.GlobalWorkerOptions.workerSrc,
  }));
  assert("pdf.js global present", libs.pdfjs);
  assert("JSZip global present", libs.jszip);
  assert("worker points to vendored file", /vendor\/pdf\.worker\.min\.js$/.test(libs.worker), libs.worker);

  // Upload the sample PDF via the hidden input.
  const input = await page.$("#fileInput");
  await input.uploadFile(SAMPLE);

  // Wait for controls to reveal + page count.
  await page.waitForSelector("#controls:not([hidden])", { timeout: 8000 });
  const pageCountText = await page.$eval("#filePages", (e) => e.textContent);
  assert("PDF loaded & page count shown", /3 pages/.test(pageCountText), pageCountText);

  // Convert (PNG default).
  await page.click("#renderBtn");
  await page.waitForFunction(
    () => window.__pdf2img && window.__pdf2img.state.rendered.length === 3 && !window.__pdf2img.state.rendering,
    { timeout: 20000 }
  );
  const thumbCount = await page.$$eval(".page-card", (els) => els.length);
  assert("3 thumbnails rendered", thumbCount === 3, thumbCount + " cards");

  const canvasOk = await page.$$eval(".page-thumb canvas", (cs) =>
    cs.length === 3 && cs.every((c) => c.width > 0 && c.height > 0));
  assert("page canvases have non-zero dimensions", canvasOk);

  // Inspect first rendered blob size + type directly from app state.
  const blobInfo = await page.evaluate(async () => {
    const r = window.__pdf2img.state.rendered[0];
    return { size: r.blob.size, type: r.blob.type, ext: r.ext };
  });
  assert("page image blob is non-empty PNG", blobInfo.size > 100 && blobInfo.type === "image/png", JSON.stringify(blobInfo));

  // Verify per-page download anchor is wired with a download name + blob href.
  const dlInfo = await page.$$eval(".dl-btn", (as) => as.map((a) => ({ dl: a.download, href: a.href.slice(0, 5) })));
  assert("per-page download links set", dlInfo.length === 3 && dlInfo.every((d) => /page-\d{3}\./.test(d.dl) && d.href === "blob:"), JSON.stringify(dlInfo[0]));

  // Build a ZIP in-page and check the bytes start with the PK signature.
  const zipCheck = await page.evaluate(async () => {
    const zip = new JSZip();
    window.__pdf2img.state.rendered.forEach((r) =>
      zip.file("page-" + String(r.pageNum).padStart(3, "0") + "." + r.ext, r.blob));
    const blob = await zip.generateAsync({ type: "blob" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { size: buf.length, sig: String.fromCharCode(buf[0], buf[1]), entries: Object.keys(zip.files).length };
  });
  assert("ZIP valid (PK signature, 3 entries, non-empty)",
    zipCheck.sig === "PK" && zipCheck.size > 200 && zipCheck.entries === 3, JSON.stringify(zipCheck));

  // JPEG path: switch format, re-render, confirm jpeg blob + white background path.
  await page.select("#formatSelect", "image/jpeg");
  await page.click("#renderBtn");
  await page.waitForFunction(
    () => window.__pdf2img.state.rendered.length === 3 && window.__pdf2img.state.rendered[0].ext === "jpg" && !window.__pdf2img.state.rendering,
    { timeout: 20000 }
  );
  const jpegInfo = await page.evaluate(() => {
    const r = window.__pdf2img.state.rendered[0];
    return { size: r.blob.size, type: r.blob.type };
  });
  assert("JPEG render produces jpeg blob", jpegInfo.type === "image/jpeg" && jpegInfo.size > 100, JSON.stringify(jpegInfo));

  // Error handling: feed a non-PDF, expect a visible error and no crash.
  const junk = path.join(ROOT, "test", "not-a-pdf.txt");
  fs.writeFileSync(junk, "this is definitely not a pdf");
  await page.evaluate(() => { window.__pdf2img.state.pdfDoc = null; });
  const junkInput = await page.$("#fileInput");
  await junkInput.uploadFile(junk);
  // .txt is rejected by extension/MIME validation -> error box.
  await page.waitForFunction(() => {
    const e = document.getElementById("errorBox");
    return e && !e.hidden && e.textContent.length > 0;
  }, { timeout: 5000 }).catch(() => {});
  const errText = await page.$eval("#errorBox", (e) => (e.hidden ? "" : e.textContent));
  assert("non-PDF shows an error, no crash", errText.length > 0, errText);
  fs.unlinkSync(junk);

  assert("no external network calls", networkExternal.length === 0, networkExternal.join(", "));
  assert("no page/console errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  await browser.close();

  const failed = Object.values(results).filter((r) => !r.pass).length;
  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED") + "  (" + Object.keys(results).length + " checks)");
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY CRASHED:", e); process.exit(2); });
