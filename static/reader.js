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
let outlineData = [];
let outlineSelectedId = null;
let outlineDirty = false;
let outlineIdCounter = 1;
let outlineDraggedId = null;
let outlineDropState = null; // { row, position }
let collapseOutlineToTopLevelOnNextLoad = false;

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
    if (!wrapper) return;
    viewerContainer.scrollTo({ top: wrapper.offsetTop - 8, behavior: "auto" });
    renderPageLazy(pageNum);
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
function nextOutlineId() {
    return `outline-${outlineIdCounter++}`;
}

function hydrateOutlineTree(nodes = []) {
    return (nodes || []).map((node) => {
        const children = hydrateOutlineTree(node.children || []);
        return {
            id: nextOutlineId(),
            title: String(node.title ?? "").trim() || "未命名目录",
            page: Number.isFinite(Number(node.page)) ? Math.max(1, Math.floor(Number(node.page))) : 1,
            children,
            expanded: children.length > 0,
        };
    });
}

function setOutlineExpandedState(nodes = outlineData, expanded = false) {
    for (const node of nodes) {
        if (node.children?.length) {
            node.expanded = expanded;
            setOutlineExpandedState(node.children, expanded);
        }
    }
}

function serializeOutlineTree(nodes = outlineData) {
    return nodes.map((node) => ({
        title: node.title,
        page: node.page,
        children: serializeOutlineTree(node.children || []),
    }));
}

function flattenOutlineNodes(nodes = outlineData, acc = []) {
    for (const node of nodes) {
        acc.push(node);
        if (node.children?.length) flattenOutlineNodes(node.children, acc);
    }
    return acc;
}

function findOutlineContext(list, nodeId, parentNode = null) {
    for (let i = 0; i < list.length; i++) {
        const node = list[i];
        if (node.id === nodeId) {
            return { node, parentList: list, parentNode, index: i };
        }
        if (node.children?.length) {
            const found = findOutlineContext(node.children, nodeId, node);
            if (found) return found;
        }
    }
    return null;
}

function outlineNodeContainsId(node, targetId) {
    if (!node) return false;
    if (node.id === targetId) return true;
    return (node.children || []).some((child) => outlineNodeContainsId(child, targetId));
}

function getOutlineSelectedContext() {
    if (!outlineSelectedId) return null;
    return findOutlineContext(outlineData, outlineSelectedId);
}

function getCurrentViewerPage() {
    if (!pdfDoc) return 1;
    const wrappers = viewer.querySelectorAll(".page-wrapper");
    const containerTop = viewerContainer.scrollTop;
    const containerMid = containerTop + viewerContainer.clientHeight / 3;
    let currentPage = 1;
    for (const w of wrappers) {
        if (w.offsetTop <= containerMid) currentPage = parseInt(w.dataset.page);
        else break;
    }
    return currentPage;
}

function clampPage(page) {
    const maxPage = pdfDoc?.numPages || Number.MAX_SAFE_INTEGER;
    return Math.max(1, Math.min(maxPage, Math.floor(page)));
}

function setOutlineStatus(text = "", type = "") {
    const el = $("#outlineStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `status-text${type ? " " + type : ""}`;
}

function syncOutlineSaveButton() {
    const btn = $("#btnOutlineSave");
    if (!btn) return;
    btn.textContent = outlineDirty ? "保存目录*" : "保存目录";
}

function markOutlineDirty(statusText = "目录已修改（未保存）") {
    outlineDirty = true;
    syncOutlineSaveButton();
    setOutlineStatus(statusText);
}

function markOutlineClean(statusText = "") {
    outlineDirty = false;
    syncOutlineSaveButton();
    if (statusText) setOutlineStatus(statusText, "success");
}

function clearOutlineDropIndicator() {
    if (outlineDropState?.row) {
        outlineDropState.row.classList.remove("drop-before", "drop-after");
    }
    outlineDropState = null;
}

function setOutlineDropIndicator(row, position) {
    if (!row) return;
    if (outlineDropState && outlineDropState.row === row && outlineDropState.position === position) return;
    clearOutlineDropIndicator();
    row.classList.add(position === "before" ? "drop-before" : "drop-after");
    outlineDropState = { row, position };
}

function createOutlineNode(seed = {}) {
    return {
        id: nextOutlineId(),
        title: seed.title || "新目录",
        page: clampPage(seed.page || getCurrentViewerPage()),
        children: [],
        expanded: true,
    };
}

function countAffectedShiftItems() {
    if (!outlineSelectedId) return 0;
    const flat = flattenOutlineNodes();
    const idx = flat.findIndex((n) => n.id === outlineSelectedId);
    return idx >= 0 ? flat.length - idx : 0;
}

function refreshOutlineEditorPanel() {
    const panel = $("#outlineEditorPanel");
    const selected = getOutlineSelectedContext();
    if (!panel) return;

    if (!selected) {
        panel.classList.add("hidden");
        $("#outlineShiftHint").textContent = "";
        return;
    }

    panel.classList.remove("hidden");
    $("#outlineEditTitle").value = selected.node.title;
    $("#outlineEditPage").value = selected.node.page;
    $("#outlineShiftHint").textContent = `影响 ${countAffectedShiftItems()} 条`;
}

function renderOutline() {
    const prevScrollTop = outlineTree.scrollTop;
    outlineTree.innerHTML = "";

    if (!outlineData.length) {
        outlineTree.innerHTML = '<div style="padding:12px;color:#999;font-size:13px;">暂无目录，可点击上方“+根目录”手动添加</div>';
        refreshOutlineEditorPanel();
        syncOutlineSaveButton();
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const node of outlineData) {
        fragment.appendChild(buildOutlineNode(node, 1));
    }
    outlineTree.appendChild(fragment);
    outlineTree.scrollTop = prevScrollTop;
    refreshOutlineEditorPanel();
    syncOutlineSaveButton();
}

function buildOutlineNode(node, level) {
    const item = document.createElement("div");
    item.className = "outline-item";
    item.dataset.level = String(level);
    item.dataset.nodeId = node.id;

    const row = document.createElement("div");
    row.className = "outline-row";
    row.dataset.nodeId = node.id;
    if (outlineSelectedId === node.id) row.classList.add("selected");

    const dragHandle = document.createElement("span");
    dragHandle.className = "outline-drag-handle";
    dragHandle.textContent = "⋮⋮";
    dragHandle.title = "拖拽移动目录项";
    dragHandle.draggable = true;
    dragHandle.addEventListener("dragstart", (e) => {
        outlineDraggedId = node.id;
        row.classList.add("dragging-source");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", node.id);
    });
    dragHandle.addEventListener("dragend", () => {
        outlineDraggedId = null;
        clearOutlineDropIndicator();
        outlineTree.querySelectorAll(".outline-row.dragging-source").forEach((el) => el.classList.remove("dragging-source"));
    });

    const hasChildren = node.children.length > 0;
    const toggle = document.createElement("span");
    toggle.className = "outline-toggle" + (hasChildren ? "" : " leaf");
    toggle.textContent = hasChildren ? (node.expanded ? "▾" : "▸") : "";
    if (hasChildren) {
        toggle.addEventListener("click", (e) => {
            e.stopPropagation();
            node.expanded = !node.expanded;
            renderOutline();
        });
    }

    const title = document.createElement("span");
    title.className = "outline-title";
    title.textContent = node.title;
    title.title = `${node.title}（第 ${node.page} 页）`;
    title.addEventListener("click", (e) => {
        e.stopPropagation();
        outlineSelectedId = node.id;
        renderOutline();
        scrollToPage(node.page);
    });

    const page = document.createElement("span");
    page.className = "outline-page";
    page.textContent = `p.${node.page}`;

    row.appendChild(dragHandle);
    row.appendChild(toggle);
    row.appendChild(title);
    row.appendChild(page);
    item.appendChild(row);

    row.addEventListener("click", () => {
        if (outlineSelectedId !== node.id) {
            outlineSelectedId = node.id;
            renderOutline();
        }
    });

    row.addEventListener("dragover", (e) => {
        if (!outlineDraggedId || outlineDraggedId === node.id) return;
        const draggedCtx = findOutlineContext(outlineData, outlineDraggedId);
        if (!draggedCtx || outlineNodeContainsId(draggedCtx.node, node.id)) return;

        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const position = (e.clientY - rect.top) < rect.height / 2 ? "before" : "after";
        setOutlineDropIndicator(row, position);
    });

    row.addEventListener("drop", (e) => {
        if (!outlineDraggedId || outlineDraggedId === node.id) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const position = (e.clientY - rect.top) < rect.height / 2 ? "before" : "after";
        const movedId = outlineDraggedId;
        const moved = moveOutlineNodeRelative(movedId, node.id, position);
        clearOutlineDropIndicator();
        outlineDraggedId = null;
        if (moved) {
            outlineSelectedId = movedId;
            renderOutline();
            markOutlineDirty("目录顺序已调整（未保存）");
        }
    });

    row.addEventListener("dragleave", (e) => {
        if (!row.contains(e.relatedTarget)) {
            row.classList.remove("drop-before", "drop-after");
            if (outlineDropState?.row === row) outlineDropState = null;
        }
    });

    if (hasChildren) {
        const childrenDiv = document.createElement("div");
        childrenDiv.className = "outline-children" + (node.expanded ? " expanded" : "");
        for (const child of node.children) {
            childrenDiv.appendChild(buildOutlineNode(child, level + 1));
        }
        item.appendChild(childrenDiv);
    }

    return item;
}

function moveOutlineNodeRelative(draggedId, targetId, position = "after") {
    if (!draggedId || !targetId || draggedId === targetId) return false;
    const draggedCtx = findOutlineContext(outlineData, draggedId);
    if (!draggedCtx) return false;
    if (outlineNodeContainsId(draggedCtx.node, targetId)) return false;

    const movedNode = draggedCtx.node;
    draggedCtx.parentList.splice(draggedCtx.index, 1);

    const targetCtx = findOutlineContext(outlineData, targetId);
    if (!targetCtx) {
        outlineData.push(movedNode);
        return true;
    }

    const insertIndex = position === "before" ? targetCtx.index : targetCtx.index + 1;
    targetCtx.parentList.splice(insertIndex, 0, movedNode);
    return true;
}

function moveOutlineNodeToRootEnd(draggedId) {
    if (!draggedId) return false;
    const draggedCtx = findOutlineContext(outlineData, draggedId);
    if (!draggedCtx) return false;
    const isAlreadyRootEnd = draggedCtx.parentList === outlineData && draggedCtx.index === outlineData.length - 1;
    if (isAlreadyRootEnd) return false;
    const movedNode = draggedCtx.node;
    draggedCtx.parentList.splice(draggedCtx.index, 1);
    outlineData.push(movedNode);
    return true;
}

function addOutlineNode(position) {
    if (position === "root") {
        const newNode = createOutlineNode();
        outlineData.push(newNode);
        outlineSelectedId = newNode.id;
        renderOutline();
        markOutlineDirty("已新增根目录（未保存）");
        setTimeout(() => {
            $("#outlineEditTitle")?.focus();
            $("#outlineEditTitle")?.select();
        }, 0);
        return;
    }

    const selected = getOutlineSelectedContext();
    if (!selected) {
        alert("请先选择一个目录项");
        return;
    }

    const newNode = createOutlineNode({ page: selected.node.page });
    if (position === "child") {
        selected.node.children.push(newNode);
        selected.node.expanded = true;
    } else if (position === "before") {
        selected.parentList.splice(selected.index, 0, newNode);
    } else {
        selected.parentList.splice(selected.index + 1, 0, newNode);
    }

    outlineSelectedId = newNode.id;
    renderOutline();
    markOutlineDirty("已新增目录项（未保存）");
    setTimeout(() => {
        $("#outlineEditTitle")?.focus();
        $("#outlineEditTitle")?.select();
    }, 0);
}

function deleteSelectedOutlineNode() {
    const selected = getOutlineSelectedContext();
    if (!selected) {
        alert("请先选择一个目录项");
        return;
    }

    const childCount = flattenOutlineNodes([selected.node]).length - 1;
    const message = childCount > 0
        ? `确定删除“${selected.node.title}”及其 ${childCount} 个子目录吗？`
        : `确定删除“${selected.node.title}”吗？`;
    if (!confirm(message)) return;

    selected.parentList.splice(selected.index, 1);
    outlineSelectedId = null;
    renderOutline();
    markOutlineDirty("目录项已删除（未保存）");
}

function applySelectedOutlineEdit() {
    const selected = getOutlineSelectedContext();
    if (!selected) {
        alert("请先选择一个目录项");
        return;
    }

    const newTitle = $("#outlineEditTitle").value.trim();
    const newPage = parseInt($("#outlineEditPage").value);
    if (!newTitle) {
        alert("目录标题不能为空");
        return;
    }
    if (!newPage || newPage < 1) {
        alert("请输入有效页码");
        return;
    }
    if (pdfDoc && newPage > pdfDoc.numPages) {
        alert(`页码不能超过总页数 ${pdfDoc.numPages}`);
        return;
    }

    const changed = selected.node.title !== newTitle || selected.node.page !== newPage;
    selected.node.title = newTitle;
    selected.node.page = newPage;
    renderOutline();
    if (changed) markOutlineDirty("目录项已更新（未保存）");
}

function jumpToSelectedOutlineNode() {
    const selected = getOutlineSelectedContext();
    if (!selected) {
        alert("请先选择一个目录项");
        return;
    }
    scrollToPage(selected.node.page);
}

function shiftOutlinePagesFromSelected(delta) {
    if (!Number.isFinite(delta) || delta === 0) return;
    if (!outlineSelectedId) {
        alert("请先选择一个目录项");
        return;
    }

    const flat = flattenOutlineNodes();
    const startIdx = flat.findIndex((node) => node.id === outlineSelectedId);
    if (startIdx < 0) return;

    let changedCount = 0;
    let clampedCount = 0;
    for (let i = startIdx; i < flat.length; i++) {
        const node = flat[i];
        const nextPage = node.page + delta;
        const clamped = clampPage(nextPage);
        if (clamped !== nextPage) clampedCount++;
        if (clamped !== node.page) {
            node.page = clamped;
            changedCount++;
        }
    }

    renderOutline();
    if (changedCount > 0) {
        const dir = delta > 0 ? "后移" : "前移";
        const extra = clampedCount > 0 ? `（${clampedCount} 条触达边界）` : "";
        markOutlineDirty(`已将当前项及后续目录整体${dir} ${Math.abs(delta)} 页${extra}`);
    } else {
        setOutlineStatus("未发生变化（可能已达到页码边界）");
    }
}

async function saveOutlineToPdf({ silentIfClean = false } = {}) {
    if (!outlineDirty) {
        if (!silentIfClean) setOutlineStatus("目录没有未保存修改");
        return true;
    }

    showLoading("正在保存目录到 PDF 书签...");
    try {
        const resp = await fetch("/api/outline/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: FILE_PATH, outline: serializeOutlineTree() }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        markOutlineClean(`目录已保存（${data.tocCount} 条）`);
        return true;
    } catch (e) {
        setOutlineStatus("保存失败: " + e.message, "error");
        return false;
    } finally {
        hideLoading();
    }
}

async function loadOutline() {
    try {
        const resp = await fetch(`/api/outline?file=${encodeURIComponent(FILE_PATH)}&t=${Date.now()}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        outlineData = hydrateOutlineTree(data.outline || []);
        if (collapseOutlineToTopLevelOnNextLoad) {
            setOutlineExpandedState(outlineData, false);
            collapseOutlineToTopLevelOnNextLoad = false;
        }
        outlineSelectedId = null;
        outlineDirty = false;
        renderOutline();
        setOutlineStatus(outlineData.length ? `已加载目录（${data.total} 条）` : "当前 PDF 暂无书签目录");
    } catch (e) {
        collapseOutlineToTopLevelOnNextLoad = false;
        outlineData = [];
        outlineSelectedId = null;
        renderOutline();
        setOutlineStatus("目录加载失败: " + e.message, "error");
    }
}

$("#btnOutlineSave").addEventListener("click", () => {
    saveOutlineToPdf();
});

$("#btnOutlineReload").addEventListener("click", async () => {
    if (outlineDirty && !confirm("目录有未保存修改，确定放弃并从 PDF 重新加载吗？")) return;
    await loadOutline();
});

$("#btnOutlineAddRoot").addEventListener("click", () => addOutlineNode("root"));
$("#btnOutlineAddBefore").addEventListener("click", () => addOutlineNode("before"));
$("#btnOutlineAddAfter").addEventListener("click", () => addOutlineNode("after"));
$("#btnOutlineAddChild").addEventListener("click", () => addOutlineNode("child"));
$("#btnOutlineDelete").addEventListener("click", deleteSelectedOutlineNode);
$("#btnOutlineApplyEdit").addEventListener("click", applySelectedOutlineEdit);
$("#btnOutlineJump").addEventListener("click", jumpToSelectedOutlineNode);

$("#outlineEditTitle").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySelectedOutlineEdit();
});
$("#outlineEditPage").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySelectedOutlineEdit();
});

$("#btnOutlineShiftBack").addEventListener("click", () => {
    const step = Math.max(1, parseInt($("#outlineShiftStep").value) || 1);
    $("#outlineShiftStep").value = step;
    shiftOutlinePagesFromSelected(-step);
});

$("#btnOutlineShiftForward").addEventListener("click", () => {
    const step = Math.max(1, parseInt($("#outlineShiftStep").value) || 1);
    $("#outlineShiftStep").value = step;
    shiftOutlinePagesFromSelected(step);
});

outlineTree.addEventListener("dragover", (e) => {
    if (!outlineDraggedId) return;
    if (e.target.closest(".outline-row")) return;
    e.preventDefault();
    clearOutlineDropIndicator();
});

outlineTree.addEventListener("drop", (e) => {
    if (!outlineDraggedId) return;
    if (e.target.closest(".outline-row")) return;
    e.preventDefault();
    clearOutlineDropIndicator();
    const movedId = outlineDraggedId;
    outlineDraggedId = null;
    const moved = moveOutlineNodeToRootEnd(movedId);
    if (moved) {
        outlineSelectedId = movedId;
        renderOutline();
        markOutlineDirty("目录已移动到根目录末尾（未保存）");
    }
});

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
            collapseOutlineToTopLevelOnNextLoad = true;
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
    if (outlineDirty) {
        const shouldSave = confirm("目录有未保存修改。点击“确定”先保存目录后再拆分；点击“取消”继续使用 PDF 当前书签拆分。");
        if (shouldSave) {
            const ok = await saveOutlineToPdf({ silentIfClean: true });
            if (!ok) return;
        }
    }

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
