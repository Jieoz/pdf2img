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
      showError("Failed to load the PDF engine (vendor/pdf.min.js). Try reloading.");
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

    bindEvents();
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
      el.scaleOut.textContent = parseFloat(el.scaleRange.value) + "×";
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
      showError("That doesn't look like a PDF. Please choose a .pdf file.");
      return;
    }

    state.fileName = (file.name || "document").replace(/\.pdf$/i, "") || "document";

    var reader = new FileReader();
    reader.onload = function () { loadPdf(new Uint8Array(reader.result)); };
    reader.onerror = function () { showError("Could not read the file from disk."); };
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
      el.filePages.textContent = pdf.numPages + (pdf.numPages === 1 ? " page" : " pages");
      el.controls.hidden = false;
      el.controls.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }).catch(function (err) {
      handleLoadError(err);
    });
  }

  function handleLoadError(err) {
    var name = err && err.name ? err.name : "";
    if (name === "PasswordException") {
      showError("This PDF is password-protected and can't be opened. Remove the password and try again.");
    } else if (name === "InvalidPDFException") {
      showError("This file appears to be corrupt or not a valid PDF.");
    } else {
      showError("Couldn't open the PDF: " + (err && err.message ? err.message : "unknown error") + ".");
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

    setRendering(true);
    updateProgress(0, total);

    // Render sequentially so we don't allocate N huge canvases at once and to
    // keep the UI responsive between pages (each page yields to the event loop).
    var pageNum = 1;

    function next() {
      if (pageNum > total) {
        setRendering(false);
        el.zipBtn.disabled = state.rendered.length === 0;
        el.progressText.textContent = "Done — " + state.rendered.length + " of " + total + " pages.";
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
          showError("Failed on page " + pageNum + ": " + (err && err.message ? err.message : err));
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
      // JPEG has no alpha — paint white so transparent areas aren't black.
      if (format === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
        return canvasToBlob(canvas, format, quality).then(function (blob) {
          var url = URL.createObjectURL(blob);
          state.rendered.push({ pageNum: pageNum, blob: blob, ext: ext, url: url });
          addThumb(canvas, pageNum, blob, ext);
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
  function addThumb(srcCanvas, pageNum, blob, ext) {
    var card = document.createElement("div");
    card.className = "page-card";

    var thumb = document.createElement("div");
    thumb.className = "page-thumb";

    // Use a downscaled copy for display to keep DOM memory reasonable on big PDFs.
    var disp = document.createElement("canvas");
    var maxW = 360;
    var ratio = srcCanvas.width > maxW ? maxW / srcCanvas.width : 1;
    disp.width = Math.max(1, Math.floor(srcCanvas.width * ratio));
    disp.height = Math.max(1, Math.floor(srcCanvas.height * ratio));
    disp.getContext("2d").drawImage(srcCanvas, 0, 0, disp.width, disp.height);
    thumb.appendChild(disp);

    var foot = document.createElement("div");
    foot.className = "page-foot";
    var label = document.createElement("span");
    label.className = "page-num";
    label.textContent = "Page " + pageNum;
    var dl = document.createElement("a");
    dl.className = "dl-btn";
    dl.textContent = "Download";
    dl.href = URL.createObjectURL(blob);
    dl.download = state.fileName + "-page-" + pad(pageNum) + "." + ext;
    foot.appendChild(label);
    foot.appendChild(dl);

    card.appendChild(thumb);
    card.appendChild(foot);
    el.pages.appendChild(card);
  }

  // ---- ZIP ----
  function downloadZip() {
    if (!state.rendered.length || typeof JSZip === "undefined") {
      if (typeof JSZip === "undefined") showError("ZIP engine (vendor/jszip.min.js) didn't load.");
      return;
    }
    el.zipBtn.disabled = true;
    var oldText = el.zipBtn.textContent;
    el.zipBtn.textContent = "Zipping…";

    var zip = new JSZip();
    state.rendered.forEach(function (r) {
      zip.file("page-" + pad(r.pageNum) + "." + r.ext, r.blob);
    });
    zip.generateAsync({ type: "blob" }, function (meta) {
      el.zipBtn.textContent = "Zipping… " + Math.round(meta.percent) + "%";
    }).then(function (content) {
      triggerDownload(content, state.fileName + "-pages.zip");
      el.zipBtn.textContent = oldText;
      el.zipBtn.disabled = false;
    }).catch(function (err) {
      showError("Couldn't build the ZIP: " + (err && err.message ? err.message : err));
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
    el.renderBtn.textContent = on ? "Converting…" : "Convert pages";
    el.progressWrap.hidden = !on && el.progressFill.style.width === "";
    if (on) el.progressWrap.hidden = false;
  }

  function updateProgress(done, total) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    el.progressFill.style.width = pct + "%";
    if (done < total) el.progressText.textContent = "Rendering page " + (done + 1) + " of " + total + "…";
  }

  function pad(n) { return String(n).padStart(3, "0"); }

  function showError(msg) { el.errorBox.textContent = msg; el.errorBox.hidden = false; }
  function clearError() { el.errorBox.hidden = true; el.errorBox.textContent = ""; }

  function clearPages() { el.pages.innerHTML = ""; }

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
