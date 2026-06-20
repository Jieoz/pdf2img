/*
 * Generates a minimal valid multi-page PDF for testing the converter.
 * Pure Node, no deps. Writes test/sample.pdf (3 pages with text).
 */
const fs = require("fs");
const path = require("path");

function buildPdf(pageCount) {
  const objects = [];
  // 1: Catalog, 2: Pages, then per page: Page + Contents
  const kidsRefs = [];
  let objNum = 3;
  const pageObjs = [];
  for (let i = 0; i < pageCount; i++) {
    const pageObjNum = objNum++;
    const contentObjNum = objNum++;
    kidsRefs.push(`${pageObjNum} 0 R`);
    const text = `Test Page ${i + 1} of ${pageCount}`;
    const stream = `BT /F1 36 Tf 72 720 Td (${text}) Tj ET\n` +
      `BT /F1 18 Tf 72 680 Td (pdf2img sample - rendered fully client-side) Tj ET\n` +
      `1 0 0 RG 4 w 72 100 m 523 740 l S`;
    pageObjs.push({
      num: pageObjNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
            `/Resources << /Font << /F1 ${objNum} 0 R >> >> /Contents ${contentObjNum} 0 R >>`,
    });
    pageObjs.push({
      num: contentObjNum,
      body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    });
  }
  const fontObjNum = objNum;

  objects.push({ num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` });
  objects.push({ num: 2, body: `<< /Type /Pages /Kids [${kidsRefs.join(" ")}] /Count ${pageCount} >>` });
  pageObjs.forEach((o) => objects.push(o));
  objects.push({ num: fontObjNum, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>` });

  objects.sort((a, b) => a.num - b.num);

  let pdf = "%PDF-1.4\n";
  const offsets = {};
  for (const o of objects) {
    offsets[o.num] = pdf.length;
    pdf += `${o.num} 0 obj\n${o.body}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  const maxNum = objects[objects.length - 1].num;
  pdf += `xref\n0 ${maxNum + 1}\n`;
  pdf += `0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets[n] || 0;
    pdf += String(off).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const outDir = path.join(__dirname);
fs.mkdirSync(outDir, { recursive: true });
const buf = buildPdf(3);
fs.writeFileSync(path.join(outDir, "sample.pdf"), buf);
console.log("Wrote test/sample.pdf (" + buf.length + " bytes, 3 pages)");
