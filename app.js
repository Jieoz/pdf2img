/*
 * PDF2Image — 100% client-side PDF → image converter.
 * Files are read in-browser via ArrayBuffer and never leave the device.
 * No network calls except the vendored libs loaded in index.html.
 */
(function () {
  "use strict";

  // pdf.js is loaded as a UMD global (pdfjsLib). Point its worker at the
  // vendored worker file so nothing is fetched from a CDN.
  if (typeof pdfjsLib === "undefined") {
    document.addEventListener("DOMContentLoaded", function () {
      showError("PDF 引擎（vendor/pdf.min.js）加载失败，请刷新页面重试。");
    });
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  // ---- State ----
  var state = {
    pdfDoc: null,      // current PDFDocumentProxy
    fileName: "document", // base name without extension
    rendered: [],      // [{ pageNum, blob, ext, url }]
    rendering: false,
    bigPageWarned: false, // only surface the big-page memory note once per run
  };

  // ---- Elements ----
  var el = {};
  function $(id) { return document.getElementById(id); }

  document.addEventListener("DOMContentLoaded", function () {
    el.dropzone = $("dropzone");
    el.fileInput = $("fileInput");
    el.controls = $("controls");
    el.fileName = $("fileName");
    el.filePages = $("filePages");
    el.formatSelect = $("formatSelect");
    el.qualityField = $("qualityField");
    el.qualityRange = $("qualityRange");
    el.qualityOut = $("qualityOut");
    el.scaleRange = $("scaleRange");
    el.scaleOut = $("scaleOut");
    el.renderBtn = $("renderBtn");
    el.zipBtn = $("zipBtn");
    el.resetBtn = $("resetBtn");
    el.progressWrap = $("progressWrap");
    el.progressFill = $("progressFill");
    el.progressText = $("progressText");
    el.errorBox = $("errorBox");
    el.pages = $("pages");
    el.pagesHint = $("pagesHint");

    bindEvents();
    // Reflect the default scale tier label on first paint.
    el.scaleOut.textContent = scaleLabel(parseFloat(el.scaleRange.value));
  });

  function bindEvents() {
    // Click / keyboard to open file picker
    el.dropzone.addEventListener("click", function () { el.fileInput.click(); });
    el.dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); }
    });
    el.fileInput.addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });

    // Drag and drop
    ["dragenter", "dragover"].forEach(function (evt) {
      el.dropzone.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        el.dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      el.dropzone.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        el.dropzone.classList.remove("dragover");
      });
    });
    el.dropzone.addEventListener("drop", function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) handleFile(dt.files[0]);
    });
    // Prevent the browser from navigating away if a file is dropped outside the zone
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) { e.preventDefault(); });

    // Controls
    el.formatSelect.addEventListener("change", function () {
      var isJpeg = el.formatSelect.value === "image/jpeg";
      el.qualityField.hidden = !isJpeg;
    });
    el.qualityRange.addEventListener("input", function () {
      el.qualityOut.textContent = Math.round(parseFloat(el.qualityRange.value) * 100) + "%";
    });
    el.scaleRange.addEventListener("input", function () {
      el.scaleOut.textContent = scaleLabel(parseFloat(el.scaleRange.value));
    });

    el.renderBtn.addEventListener("click", renderAll);
    el.zipBtn.addEventListener("click", downloadZip);
    el.resetBtn.addEventListener("click", resetAll);
  }

  // ---- File handling ----
  function handleFile(file) {
    clearError();
    // Validate it's a PDF (by MIME and/or extension; some browsers omit type).
    var nameLooksPdf = /\.pdf$/i.test(file.name || "");
    var typeLooksPdf = file.type === "application/pdf" || file.type === "";
    if (!nameLooksPdf && !typeLooksPdf) {
      showError("这看起来不是 PDF 文件，请选择一个 .pdf 文件。");
      return;
    }

    state.fileName = (file.name || "document").replace(/\.pdf$/i, "") || "document";

    var reader = new FileReader();
    reader.onload = function () { loadPdf(new Uint8Array(reader.result)); };
    reader.onerror = function () { showError("无法从磁盘读取该文件。"); };
    reader.readAsArrayBuffer(file);
  }

  function loadPdf(data) {
    clearError();
    clearPages();
    setRendering(false);
    el.zipBtn.disabled = true;

    // password: undefined — pdf.js will reject with a PasswordException we catch.
    var task = pdfjsLib.getDocument({ data: data });
    task.promise.then(function (pdf) {
      state.pdfDoc = pdf;
      el.fileName.textContent = state.fileName + ".pdf";
      el.filePages.textContent = "共 " + pdf.numPages + " 页";
      el.controls.hidden = false;
      el.controls.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }).catch(function (err) {
      handleLoadError(err);
    });
  }

  function handleLoadError(err) {
    var name = err && err.name ? err.name : "";
    if (name === "PasswordException") {
      showError("这个 PDF 设了密码，无法打开。请先去掉密码再试。");
    } else if (name === "InvalidPDFException") {
      showError("这个文件可能已损坏，或者不是有效的 PDF。");
    } else {
      showError("打开 PDF 失败：" + (err && err.message ? err.message : "未知错误") + "。");
    }
    el.controls.hidden = true;
  }

  // ---- Rendering ----
  function renderAll() {
    if (!state.pdfDoc || state.rendering) return;
    clearError();
    clearPages();
    revokeUrls();
    state.rendered = [];

    var format = el.formatSelect.value;           // "image/png" | "image/jpeg"
    var ext = format === "image/jpeg" ? "jpg" : "png";
    var quality = parseFloat(el.qualityRange.value);
    var scale = parseFloat(el.scaleRange.value);
    var total = state.pdfDoc.numPages;

    state.bigPageWarned = false;
    setRendering(true);
    updateProgress(0, total);

    // Render sequentially so we don't allocate N huge canvases at once and to
    // keep the UI responsive between pages (each page yields to the event loop).
    var pageNum = 1;

    function next() {
      if (pageNum > total) {
        setRendering(false);
        el.zipBtn.disabled = state.rendered.length === 0;
        el.progressText.textContent = "完成 —— 共 " + total + " 页，已转换 " + state.rendered.length + " 页。";
        return;
      }
      renderPage(pageNum, scale, format, ext, quality)
        .then(function () {
          updateProgress(pageNum, total);
          pageNum++;
          // Yield to the browser so thumbnails paint incrementally.
          setTimeout(next, 0);
        })
        .catch(function (err) {
          showError("第 " + pageNum + " 页转换失败：" + (err && err.message ? err.message : err));
          setRendering(false);
        });
    }
    next();
  }

  function renderPage(pageNum, scale, format, ext, quality) {
    return state.pdfDoc.getPage(pageNum).then(function (page) {
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement("canvas");
      var ctx = canvas.getContext("2d");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // Very large output canvases can spike memory. Surface a one-time, non-blocking
      // note (no hard page/size limit — the user asked for clarity, let them have it).
      if (!state.bigPageWarned && canvas.width * canvas.height > 25000000) {
        state.bigPageWarned = true;
        showError("提示：当前清晰度下页面尺寸很大（" + canvas.width + "×" + canvas.height +
          " 像素），占用内存较高。若浏览器卡顿，可把清晰度调低一档。");
      }
      // JPEG has no alpha — paint white so transparent areas aren't black.
      if (format === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
        // Export uses the full-resolution canvas — the on-screen thumbnail is a
        // separate downscaled copy (see addThumb), so exports stay crisp.
        return canvasToBlob(canvas, format, quality).then(function (blob) {
          var url = URL.createObjectURL(blob);
          state.rendered.push({ pageNum: pageNum, blob: blob, ext: ext, url: url });
          addThumb(canvas, pageNum, url, ext);
          // Free the page resources we no longer need.
          page.cleanup();
        });
      });
    });
  }

  function canvasToBlob(canvas, format, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"));
        }, format, format === "image/jpeg" ? quality : undefined);
      } else {
        // Fallback for very old engines.
        try {
          var dataUrl = canvas.toDataURL(format, quality);
          var bin = atob(dataUrl.split(",")[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: format }));
        } catch (e) { reject(e); }
      }
    });
  }

  // ---- Thumbnails ----
  // `fullUrl` is the object URL of the FULL-resolution exported blob (created in
  // renderPage). We reuse it both for the click-to-open-in-new-tab behaviour and
  // for the Download link, so we never spawn a second URL or downscale the export.
  function addThumb(srcCanvas, pageNum, fullUrl, ext) {
    var card = document.createElement("div");
    card.className = "page-card";

    var thumb = document.createElement("div");
    thumb.className = "page-thumb";
    thumb.setAttribute("role", "button");
    thumb.setAttribute("tabindex", "0");
    thumb.setAttribute("aria-label", "查看第 " + pageNum + " 页的全分辨率大图");
    thumb.title = "点击查看大图";

    // Use a downscaled copy for display to keep DOM memory reasonable on big PDFs.
    // High-quality smoothing keeps the on-screen preview crisp instead of blocky.
    var disp = document.createElement("canvas");
    var maxW = 360;
    var ratio = srcCanvas.width > maxW ? maxW / srcCanvas.width : 1;
    disp.width = Math.max(1, Math.floor(srcCanvas.width * ratio));
    disp.height = Math.max(1, Math.floor(srcCanvas.height * ratio));
    var dctx = disp.getContext("2d");
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = "high";
    dctx.drawImage(srcCanvas, 0, 0, disp.width, disp.height);
    thumb.appendChild(disp);

    // Click / Enter / Space → open the full-resolution image in a new tab.
    function openFull() { window.open(fullUrl, "_blank"); }
    thumb.addEventListener("click", openFull);
    thumb.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFull(); }
    });

    var foot = document.createElement("div");
    foot.className = "page-foot";
    var label = document.createElement("span");
    label.className = "page-num";
    label.textContent = "第 " + pageNum + " 页";
    var dl = document.createElement("a");
    dl.className = "dl-btn";
    dl.textContent = "下载";
    dl.href = fullUrl;
    dl.download = state.fileName + "-page-" + pad(pageNum) + "." + ext;
    foot.appendChild(label);
    foot.appendChild(dl);

    card.appendChild(thumb);
    card.appendChild(foot);
    el.pages.appendChild(card);
    if (el.pagesHint) el.pagesHint.hidden = false;
  }

  // ---- ZIP ----
  function downloadZip() {
    if (!state.rendered.length || typeof JSZip === "undefined") {
      if (typeof JSZip === "undefined") showError("ZIP 引擎（vendor/jszip.min.js）加载失败。");
      return;
    }
    el.zipBtn.disabled = true;
    var oldText = el.zipBtn.textContent;
    el.zipBtn.textContent = "打包中…";

    var zip = new JSZip();
    state.rendered.forEach(function (r) {
      zip.file("page-" + pad(r.pageNum) + "." + r.ext, r.blob);
    });
    zip.generateAsync({ type: "blob" }, function (meta) {
      el.zipBtn.textContent = "打包中… " + Math.round(meta.percent) + "%";
    }).then(function (content) {
      triggerDownload(content, state.fileName + "-pages.zip");
      el.zipBtn.textContent = oldText;
      el.zipBtn.disabled = false;
    }).catch(function (err) {
      showError("打包 ZIP 失败：" + (err && err.message ? err.message : err));
      el.zipBtn.textContent = oldText;
      el.zipBtn.disabled = false;
    });
  }

  function triggerDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ---- UI helpers ----
  function setRendering(on) {
    state.rendering = on;
    el.renderBtn.disabled = on;
    el.renderBtn.textContent = on ? "转换中…" : "转换全部页面";
    el.progressWrap.hidden = !on && el.progressFill.style.width === "";
    if (on) el.progressWrap.hidden = false;
  }

  function updateProgress(done, total) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    el.progressFill.style.width = pct + "%";
    if (done < total) el.progressText.textContent = "正在渲染第 " + (done + 1) + " / " + total + " 页…";
  }

  // Map a render scale to a friendly tier label, e.g. "2×（高清）".
  function scaleLabel(scale) {
    var tier;
    if (scale <= 1) tier = "标清";
    else if (scale < 2) tier = "清晰";
    else if (scale < 3) tier = "高清";
    else if (scale < 4) tier = "超清";
    else tier = "极清";
    return scale + "×（" + tier + "）";
  }

  function pad(n) { return String(n).padStart(3, "0"); }

  function showError(msg) { el.errorBox.textContent = msg; el.errorBox.hidden = false; }
  function clearError() { el.errorBox.hidden = true; el.errorBox.textContent = ""; }

  function clearPages() {
    el.pages.innerHTML = "";
    if (el.pagesHint) el.pagesHint.hidden = true;
  }

  function revokeUrls() {
    state.rendered.forEach(function (r) { if (r.url) URL.revokeObjectURL(r.url); });
  }

  function resetAll() {
    if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch (e) {} }
    revokeUrls();
    state.pdfDoc = null;
    state.rendered = [];
    state.fileName = "document";
    setRendering(false);
    clearPages();
    clearError();
    el.controls.hidden = true;
    el.zipBtn.disabled = true;
    el.progressWrap.hidden = true;
    el.progressFill.style.width = "";
    el.fileInput.value = "";
  }

  // Expose a tiny hook for headless verification (no effect on normal use).
  window.__pdf2img = { state: state };
})();
