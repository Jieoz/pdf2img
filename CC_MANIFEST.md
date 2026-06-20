# CC_MANIFEST — pdf2img 中文化 + 修模糊 + 缩略图点击放大

## 改了哪些文件
- `index.html` — 全界面中文化；`<html lang>` → `zh-CN`；清晰度滑块 `max` 1→4（默认仍 2，step 0.5）；标签显示档位「2×（高清）」；新增点击提示文案 `#pagesHint`。品牌名 PDF2Image 保留。
- `style.css` — 缩略图加 `cursor:pointer` + hover/focus 高亮 + 「🔍 查看大图」悬浮角标；新增 `.pages-hint` 样式。
- `app.js` — 所有可见文案 / showError / 进度 / 按钮文本中文化；缩略图降采样开启高质量平滑；缩略图点击/Enter/Space → 新标签打开全分辨率 blob；下载链接复用同一全分辨率 URL（顺带修掉原来下载链接重复 createObjectURL 不回收的泄漏）；新增 `scaleLabel()` 档位映射；超大页（>2500 万像素）一次性内存提示，无硬性页数限制。
- `test/verify.js` — 页数断言改中文格式；新增 4 项断言（中文 UI、默认 scale≥2、缩略图点击 window.open blob、2× 像素显著大于 1× 基线），并补充 measureBlob 辅助。

## 模糊问题的具体修法（根因 + 前后值）
两处根因，均已修：
1. **屏幕预览发虚**：`addThumb` 里降采样 `drawImage` 此前用默认低质量重采样 → 缩略图发虚。
   - 修法：`dctx.imageSmoothingEnabled = true; dctx.imageSmoothingQuality = "high";`
2. **导出分辨率/档位**：滑块上限 `max` **3 → 4**（等效 ~288 DPI），默认值保持 **2×（高清）**（等效 ~150 DPI，清晰）。标签由纯「2×」→「2×（高清）」分档显示（标清/清晰/高清/超清/极清）。
   - 导出仍用**全分辨率原 canvas**（`canvasToBlob(canvas...)` 未改），只把屏幕预览缩小到 360px 宽。verify 实测：默认 2× 输出 1190×1684，1× 基线 595×842（精确 2 倍），未退化。

## 缩略图点击放大实现方式
- `renderPage` 已 `URL.createObjectURL(blob)` 得到全分辨率 `r.url`，传给 `addThumb(canvas, pageNum, fullUrl, ext)`。
- `.page-thumb` 加 `role=button` + `tabindex=0` + aria-label，绑 `click` 与 `keydown`(Enter/Space) → `window.open(fullUrl, "_blank")`。
- 下载链接 `dl.href = fullUrl`（复用同一 URL，非降采样 disp），ZIP 仍用 `r.blob`。
- 首张缩略图出现时显示中文提示「点击任意缩略图，可在新标签页查看全分辨率大图」。

## commands_run
- `node --check app.js` → OK
- `CHROME_BIN=$(find /root/.cache/ms-playwright -name chrome|head -1) node test/verify.js` → **ALL PASS (18 checks), EXIT=0**

## verification_result（逐条 PASS）
1. pdf.js global present — PASS
2. JSZip global present — PASS
3. worker points to vendored file — PASS
4. PDF loaded & page count shown（共 3 页）— PASS
5. UI is in Chinese (lang=zh-CN + 关键串) — PASS【新增 c】
6. default scale >= 2 — PASS【新增 a】
7. 3 thumbnails rendered — PASS
8. page canvases non-zero dims — PASS
9. page image blob non-empty PNG — PASS
10. per-page download links set — PASS
11. thumbnail click opens full-res blob (_blank, blob:, 匹配 state.url) — PASS【新增 b】
12. default (2x) output has real pixels — PASS【新增 a】
13. ZIP valid (PK, 3 entries) — PASS
14. JPEG render produces jpeg blob — PASS
15. default 2x output sharper than 1x baseline（1190×1684 vs 595×842）— PASS【新增 a】
16. non-PDF shows error, no crash（中文错误）— PASS
17. no external network calls — PASS
18. no page/console errors — PASS

既有 13 项全部不回归；新增 5 项全部 PASS。

## risks_or_leftovers
- 4× 大页面 + 多页可能吃内存；已用一次性中文提示兜底（>2500 万像素），按 brief 未加硬性页数限制。
- `scaleLabel` 仅对 1/1.5/2/2.5/3/3.5/4 档位友好；分界用 `<` 处理，2.5 显示「高清」、3.5 显示「超清」，符合直觉。
- 缩略图 hover 角标用 CSS `::after` 文案「🔍 查看大图」，纯装饰、不影响 a11y（已有 aria-label）。

## things_deliberately_not_touched
- `vendor/`（pdf.js 3.11.174 / JSZip 3.10.1）未动，无网络/构建步骤。
- 导出路径 `canvasToBlob(canvas...)` 全分辨率逻辑未改。
- 未 push、未碰 remote（按 brief，主会话负责 push 与部署）。
- `test/landing.png`、`test/rendered.png`（既有未跟踪截图）按 brief 的 `git add -A` 一并纳入提交。
