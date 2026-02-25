// PDF.js 动态导入
const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs";

const FILE_PATH = window.PDF_FILE;

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
let pdfDoc = null;
let currentScale = 1;
let tocPdfRel = null;
let pageStates = [];  // [{wrapper, rendered, rendering}, ...]
let pageObserver = null;

// ──────────────────────────────────────────────
// DOM References
// ──────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const viewer = $("#viewer");
const viewerContainer = $("#viewerContainer");
const sidebar = $("#sidebar");
const outlineTree = $("#outlineTree");
const resizer = $("#resizer");

// ──────────────────────────────────────────────
// PDF Loading & Lazy Rendering
// ──────────────────────────────────────────────
async function loadPdf() {
    showLoading("正在加载 PDF...");
    const url = `/api/pdf?file=${encodeURIComponent(FILE_PATH)}&t=${Date.now()}`;
    pdfDoc = await pdfjsLib.getDocument({ url, disableAutoFetch: false }).promise;
    $("#pageInfo").textContent = `共 ${pdfDoc.numPages} 页`;
    await setupPages();
    hideLoading();
    loadOutline();
}

async function setupPages() {
    viewer.innerHTML = "";
    pageStates = [];

    // Disconnect old observer
    if (pageObserver) pageObserver.disconnect();

    // Get first page to determine default size
    const firstPage = await pdfDoc.getPage(1);
    const defaultVp = firstPage.getViewport({ scale: currentScale });

    // Create placeholders for all pages
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const wrapper = document.createElement("div");
        wrapper.className = "page-wrapper page-placeholder";
        wrapper.dataset.page = i;
        wrapper.style.width = defaultVp.width + "px";
        wrapper.style.height = defaultVp.height + "px";
        viewer.appendChild(wrapper);
        pageStates.push({ wrapper, rendered: false, rendering: false });
    }

    // Setup IntersectionObserver for lazy rendering
    pageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                const pageNum = parseInt(entry.target.dataset.page);
                renderPageLazy(pageNum);
            }
        }
    }, {
        root: viewerContainer,
        rootMargin: "200% 0px",  // pre-render 2 screens ahead/behind
    });

    for (const state of pageStates) {
        pageObserver.observe(state.wrapper);
    }
}

async function renderPageLazy(pageNum) {
    const state = pageStates[pageNum - 1];
    if (!state || state.rendered || state.rendering) return;
    state.rendering = true;

    const page = await pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: currentScale });
    const dpr = window.devicePixelRatio || 1;

    const wrapper = state.wrapper;
    wrapper.innerHTML = "";
    wrapper.classList.remove("page-placeholder");
    wrapper.style.width = vp.width + "px";
    wrapper.style.height = vp.height + "px";

    const canvas = document.createElement("canvas");
    canvas.width = vp.width * dpr;
    canvas.height = vp.height * dpr;
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";

    wrapper.appendChild(canvas);
    wrapper.appendChild(textLayerDiv);

    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: vp,
    });
    await textLayer.render();

    state.rendered = true;
    state.rendering = false;
}

// Render a page into arbitrary container (for modals)
async function renderPageInto(container, page, scale) {
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale });

    const wrapper = document.createElement("div");
    wrapper.className = "page-wrapper";
    wrapper.style.width = vp.width + "px";
    wrapper.style.height = vp.height + "px";

    const canvas = document.createElement("canvas");
    canvas.width = vp.width * dpr;
    canvas.height = vp.height * dpr;
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";

    wrapper.appendChild(canvas);
    wrapper.appendChild(textLayerDiv);
    container.appendChild(wrapper);

    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: vp,
    });
    await textLayer.render();

    return wrapper;
}

function scrollToPage(pageNum) {
    const wrapper = viewer.querySelector(`.page-wrapper[data-page="${pageNum}"]`);
    if (wrapper) wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Track current visible page
viewerContainer.addEventListener("scroll", () => {
    if (!pdfDoc) return;
    const wrappers = viewer.querySelectorAll(".page-wrapper");
    const containerTop = viewerContainer.scrollTop;
    const containerMid = containerTop + viewerContainer.clientHeight / 3;
    let currentPage = 1;
    for (const w of wrappers) {
        if (w.offsetTop <= containerMid) currentPage = parseInt(w.dataset.page);
        else break;
    }
    $("#pageInfo").textContent = `${currentPage} / ${pdfDoc.numPages}`;
});

// ──────────────────────────────────────────────
// Zoom
// ──────────────────────────────────────────────
const zoomSelect = $("#zoomSelect");

async function setScale(newScale) {
    currentScale = newScale;
    zoomSelect.value = newScale;
    // Reset all pages and re-setup lazy rendering
    await setupPages();
}

$("#btnZoomIn").addEventListener("click", () => {
    const opts = [...zoomSelect.options].map(o => parseFloat(o.value));
    const idx = opts.indexOf(currentScale);
    if (idx < opts.length - 1) setScale(opts[idx + 1]);
});

$("#btnZoomOut").addEventListener("click", () => {
    const opts = [...zoomSelect.options].map(o => parseFloat(o.value));
    const idx = opts.indexOf(currentScale);
    if (idx > 0) setScale(opts[idx - 1]);
});

zoomSelect.addEventListener("change", () => setScale(parseFloat(zoomSelect.value)));

// ──────────────────────────────────────────────
// Outline
// ──────────────────────────────────────────────
async function loadOutline() {
    const resp = await fetch(`/api/outline?file=${encodeURIComponent(FILE_PATH)}&t=${Date.now()}`);
    const data = await resp.json();
    outlineTree.innerHTML = "";
    if (!data.outline || data.outline.length === 0) {
        outlineTree.innerHTML = '<div style="padding:12px;color:#999;font-size:13px;">暂无目录</div>';
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const node of data.outline) {
        fragment.appendChild(buildOutlineNode(node));
    }
    outlineTree.appendChild(fragment);
}

function buildOutlineNode(node) {
    const item = document.createElement("div");
    item.className = "outline-item";
    item.dataset.level = node.level;

    const row = document.createElement("div");
    row.className = "outline-row";

    const toggle = document.createElement("span");
    toggle.className = "outline-toggle" + (node.children.length === 0 ? " leaf" : "");
    toggle.textContent = node.children.length > 0 ? "▸" : "";

    const title = document.createElement("span");
    title.className = "outline-title";
    title.textContent = node.title;
    title.title = node.title;

    const page = document.createElement("span");
    page.className = "outline-page";
    page.textContent = node.page;

    row.appendChild(toggle);
    row.appendChild(title);
    row.appendChild(page);
    item.appendChild(row);

    // Click title → jump to page
    title.addEventListener("click", (e) => {
        e.stopPropagation();
        scrollToPage(node.page);
    });

    // Children
    if (node.children.length > 0) {
        const childrenDiv = document.createElement("div");
        childrenDiv.className = "outline-children";
        for (const child of node.children) {
            childrenDiv.appendChild(buildOutlineNode(child));
        }
        item.appendChild(childrenDiv);

        // Toggle expand/collapse
        toggle.addEventListener("click", (e) => {
            e.stopPropagation();
            const expanded = childrenDiv.classList.toggle("expanded");
            toggle.textContent = expanded ? "▾" : "▸";
        });
        row.addEventListener("click", () => {
            const expanded = childrenDiv.classList.toggle("expanded");
            toggle.textContent = expanded ? "▾" : "▸";
        });
    }

    return item;
}

// ──────────────────────────────────────────────
// Sidebar resize & hide
// ──────────────────────────────────────────────
let isResizing = false;

resizer.addEventListener("mousedown", (e) => {
    isResizing = true;
    resizer.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const newWidth = Math.max(180, Math.min(500, e.clientX));
    sidebar.style.width = newWidth + "px";
});

document.addEventListener("mouseup", () => {
    if (isResizing) {
        isResizing = false;
        resizer.classList.remove("active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    }
});

// Hide / Show sidebar
$("#btnHideSidebar").addEventListener("click", () => {
    sidebar.classList.add("hidden");
    resizer.classList.add("hidden");
    $("#btnShowSidebar").classList.remove("hidden");
});

$("#btnShowSidebar").addEventListener("click", () => {
    sidebar.classList.remove("hidden");
    resizer.classList.remove("hidden");
    $("#btnShowSidebar").classList.add("hidden");
});

// ──────────────────────────────────────────────
// Extract TOC pages
// ──────────────────────────────────────────────
const tocExtractPanel = $("#tocExtractPanel");

$("#btnExtractToc").addEventListener("click", () => {
    tocExtractPanel.classList.toggle("hidden");
});

$("#btnConfirmExtract").addEventListener("click", async () => {
    const startPage = parseInt($("#tocStart").value);
    const endPage = parseInt($("#tocEnd").value);
    if (!startPage || !endPage || startPage > endPage) {
        alert("请输入有效的起始页和结束页");
        return;
    }

    showLoading("正在提取目录页...");
    try {
        const resp = await fetch("/api/extract-toc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: FILE_PATH, startPage, endPage }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);

        tocPdfRel = data.tocPdf;
        const link = $("#linkViewToc");
        link.classList.remove("hidden");
        link.textContent = "查看目录页";
    } catch (e) {
        alert("提取失败: " + e.message);
    }
    hideLoading();
});

// View TOC PDF in modal
$("#linkViewToc").addEventListener("click", async (e) => {
    e.preventDefault();
    if (!tocPdfRel) return;
    openTocModal(tocPdfRel);
});

// ──────────────────────────────────────────────
// TOC Modal - view extracted TOC PDF
// ──────────────────────────────────────────────
async function openTocModal(tocPath) {
    const modal = $("#tocModal");
    modal.classList.remove("hidden");
    const tocViewer = $("#tocViewer");
    tocViewer.innerHTML = "";
    $("#offsetPanel").classList.add("hidden");
    $("#tocStatus").textContent = "";

    showLoading("正在加载目录页...");
    try {
        const url = `/api/pdf?file=${encodeURIComponent(tocPath)}`;
        const tocDoc = await pdfjsLib.getDocument(url).promise;

        for (let i = 1; i <= tocDoc.numPages; i++) {
            const page = await tocDoc.getPage(i);
            await renderPageInto(tocViewer, page, 1.5);
        }
    } catch (e) {
        tocViewer.innerHTML = `<div style="padding:20px;color:red;">加载失败: ${e.message}</div>`;
    }
    hideLoading();
}

// Auto add TOC
$("#btnAutoAddToc").addEventListener("click", () => {
    $("#offsetPanel").classList.toggle("hidden");
});

$("#btnConfirmAddToc").addEventListener("click", async () => {
    const pageOffset = parseInt($("#pageOffset").value) || 0;
    const status = $("#tocStatus");
    status.textContent = "正在调用 Gemini 解析目录...请稍候";
    status.className = "status-text";

    showLoading("正在通过 Gemini 解析并添加目录...");
    try {
        const resp = await fetch("/api/add-toc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: FILE_PATH, tocPdf: tocPdfRel, pageOffset }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);

        status.textContent = `添加成功！共 ${data.tocCount} 条目录`;
        status.className = "status-text success";

        // 关闭弹窗，刷新 PDF 和 outline
        setTimeout(async () => {
            $("#tocModal").classList.add("hidden");
            tocPdfRel = null;
            $("#linkViewToc").classList.add("hidden");
            $("#tocExtractPanel").classList.add("hidden");
            await loadPdf();
        }, 1200);

    } catch (e) {
        status.textContent = "失败: " + e.message;
        status.className = "status-text error";
    }
    hideLoading();
});

// ──────────────────────────────────────────────
// Split Chapters
// ──────────────────────────────────────────────
$("#btnSplitChapters").addEventListener("click", async () => {
    const modal = $("#splitModal");
    const list = $("#chapterList");
    const status = $("#splitStatus");
    list.innerHTML = "";
    status.textContent = "";

    showLoading("正在获取目录...");
    try {
        const resp = await fetch(`/api/top-chapters?file=${encodeURIComponent(FILE_PATH)}`);
        const data = await resp.json();

        if (data.error) {
            alert(data.error);
            hideLoading();
            return;
        }
        if (data.chapters.length === 0) {
            alert("未找到一级目录，请先添加目录书签。");
            hideLoading();
            return;
        }

        for (const ch of data.chapters) {
            const item = document.createElement("label");
            item.className = "chapter-item";

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = true;
            cb.dataset.title = ch.title;
            cb.dataset.page = ch.page;

            const titleSpan = document.createElement("span");
            titleSpan.textContent = ch.title;

            const pageSpan = document.createElement("span");
            pageSpan.className = "chapter-page";
            pageSpan.textContent = `p.${ch.page}`;

            item.appendChild(cb);
            item.appendChild(titleSpan);
            item.appendChild(pageSpan);
            list.appendChild(item);
        }

        modal.classList.remove("hidden");
    } catch (e) {
        alert("获取章节失败: " + e.message);
    }
    hideLoading();
});

// Select all / Deselect all
$("#btnSelectAll").addEventListener("click", () => {
    $("#chapterList").querySelectorAll("input[type=checkbox]").forEach(cb => cb.checked = true);
});
$("#btnDeselectAll").addEventListener("click", () => {
    $("#chapterList").querySelectorAll("input[type=checkbox]").forEach(cb => cb.checked = false);
});

// Start split
$("#btnStartSplit").addEventListener("click", async () => {
    const checkboxes = $("#chapterList").querySelectorAll("input[type=checkbox]:checked");
    if (checkboxes.length === 0) {
        alert("请至少选择一个章节");
        return;
    }

    const chapters = [...checkboxes].map(cb => ({
        title: cb.dataset.title,
        page: parseInt(cb.dataset.page),
    }));

    const status = $("#splitStatus");
    showLoading("正在拆分章节...");
    try {
        const resp = await fetch("/api/split-chapters", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: FILE_PATH, chapters }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);

        status.textContent = `拆分完成！共 ${data.chapters.length} 章 → ${data.outputDir}/`;
        status.className = "status-text success";
    } catch (e) {
        status.textContent = "拆分失败: " + e.message;
        status.className = "status-text error";
    }
    hideLoading();
});

// ──────────────────────────────────────────────
// Modal close buttons
// ──────────────────────────────────────────────
document.querySelectorAll(".btn-close").forEach(btn => {
    btn.addEventListener("click", () => {
        const modalId = btn.dataset.close;
        if (modalId) document.getElementById(modalId).classList.add("hidden");
    });
});

// Close modal on backdrop click
document.querySelectorAll(".modal").forEach(modal => {
    modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.add("hidden");
    });
});

// ──────────────────────────────────────────────
// Loading helpers
// ──────────────────────────────────────────────
function showLoading(text = "加载中...") {
    $("#loadingText").textContent = text;
    $("#loadingOverlay").classList.remove("hidden");
}

function hideLoading() {
    $("#loadingOverlay").classList.add("hidden");
}

// ──────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────
loadPdf();
