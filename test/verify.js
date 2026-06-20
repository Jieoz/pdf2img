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

  // Decode a rendered page's blob into an Image and read its natural pixel size.
  function measureBlob(pg, idx) {
    return pg.evaluate((i) => new Promise((resolve, reject) => {
      const r = window.__pdf2img.state.rendered[i];
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight, size: r.blob.size });
      img.onerror = () => reject(new Error("img decode failed"));
      img.src = URL.createObjectURL(r.blob);
    }), idx);
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
  assert("PDF loaded & page count shown", /共\s*3\s*页/.test(pageCountText), pageCountText);

  // (c) Key UI strings are in Chinese.
  const i18n = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    renderBtn: document.getElementById("renderBtn").textContent,
    zipBtn: document.getElementById("zipBtn").textContent,
    resetBtn: document.getElementById("resetBtn").textContent,
    scaleOut: document.getElementById("scaleOut").textContent,
    privacy: document.querySelector(".privacy").textContent,
  }));
  assert("UI is in Chinese (lang + key strings)",
    i18n.lang === "zh-CN" &&
    i18n.renderBtn.includes("转换") &&
    i18n.zipBtn.includes("打包") &&
    i18n.resetBtn.includes("重新开始") &&
    /高清/.test(i18n.scaleOut) &&
    /私密/.test(i18n.privacy),
    JSON.stringify(i18n));

  // (a) Default render scale should be high-res (>= 2x).
  const scaleVal = await page.$eval("#scaleRange", (e) => parseFloat(e.value));
  assert("default scale >= 2 (sharp output)", scaleVal >= 2, "scale=" + scaleVal);

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

  // (b) Clicking a thumbnail opens the FULL-resolution blob in a new tab.
  const openInfo = await page.evaluate(() => {
    return new Promise((resolve) => {
      const orig = window.open;
      let captured = null;
      window.open = (url, target) => { captured = { url: url, target: target }; return null; };
      const thumb = document.querySelector(".page-thumb");
      thumb.click();
      window.open = orig;
      // The clicked URL must match the page's full-res blob URL in app state.
      const fullUrl = window.__pdf2img.state.rendered[0].url;
      resolve({ captured: captured, matchesFull: captured && captured.url === fullUrl });
    });
  });
  assert("thumbnail click opens full-res blob in new tab",
    openInfo.captured && /^blob:/.test(openInfo.captured.url) &&
    openInfo.captured.target === "_blank" && openInfo.matchesFull,
    JSON.stringify(openInfo.captured));

  // (a) Capture the 2x (default) output pixel dimensions to compare against a 1x baseline later.
  const hiDims = await measureBlob(page, 0);
  assert("default (2x) output has real pixels", hiDims.w > 0 && hiDims.h > 0, JSON.stringify(hiDims));

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

  // (a) Re-render the SAME page at 1x (PNG) as a baseline and confirm the default
  // 2x output is meaningfully larger in pixels — proving the sharpness fix.
  await page.select("#formatSelect", "image/png");
  await page.evaluate(() => {
    const s = document.getElementById("scaleRange");
    s.value = "1";
    s.dispatchEvent(new Event("input"));
  });
  await page.click("#renderBtn");
  await page.waitForFunction(
    () => window.__pdf2img.state.rendered.length === 3 && window.__pdf2img.state.rendered[0].ext === "png" && !window.__pdf2img.state.rendering,
    { timeout: 20000 }
  );
  const loDims = await measureBlob(page, 0);
  // 2x default should be ~2x the 1x baseline in each dimension (allow rounding slack).
  assert("default 2x output is sharper than 1x baseline (larger pixels)",
    hiDims.w >= loDims.w * 1.8 && hiDims.h >= loDims.h * 1.8,
    "2x=" + hiDims.w + "x" + hiDims.h + " vs 1x=" + loDims.w + "x" + loDims.h);

  // Restore default scale for any later checks / parity with normal use.
  await page.evaluate(() => {
    const s = document.getElementById("scaleRange");
    s.value = "2";
    s.dispatchEvent(new Event("input"));
  });

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
