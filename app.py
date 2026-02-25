#!/usr/bin/env python3
"""
PDF 网页版阅读器 - Flask 后端

启动: python app.py
浏览器打开: http://127.0.0.1:5000
"""

import base64
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from urllib.parse import unquote, urlparse

import fitz  # pymupdf
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file, abort, redirect, url_for
from werkzeug.utils import secure_filename

# 复用现有模块
from main import extract_toc_pages, parse_toc_with_gemini, add_bookmarks
from split_chapters import get_toc_from_bookmarks, find_top_level_chapters, sanitize_filename

load_dotenv()

app = Flask(__name__)

# 允许浏览的根目录（当前工作目录）
BASE_DIR = os.getcwd()
LAST_OPENED_FILE = os.path.join(BASE_DIR, ".pdf_last_opened.json")
EXTERNAL_REF_PREFIX = "@ext:"


def _is_under_base_dir(abs_path):
    """判断路径是否在工作目录内。"""
    try:
        return os.path.commonpath([os.path.abspath(BASE_DIR), os.path.abspath(abs_path)]) == os.path.abspath(BASE_DIR)
    except ValueError:
        return False


def _safe_path(filepath):
    """确保路径在允许范围内，返回绝对路径。"""
    abs_path = os.path.abspath(filepath)
    if not _is_under_base_dir(abs_path):
        abort(403, "Access denied")
    return abs_path


def _encode_external_ref(abs_path):
    """将工作目录外的绝对路径编码为前端可传递的 file token。"""
    token = base64.urlsafe_b64encode(os.path.abspath(abs_path).encode("utf-8")).decode("ascii").rstrip("=")
    return f"{EXTERNAL_REF_PREFIX}{token}"


def _decode_external_ref(file_ref):
    """解析外部文件 token。"""
    token = (file_ref or "")[len(EXTERNAL_REF_PREFIX):]
    if not token:
        abort(400, "Invalid external file token")
    try:
        token += "=" * (-len(token) % 4)
        abs_path = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
    except Exception:
        abort(400, "Invalid external file token")
    return os.path.abspath(abs_path)


def _resolve_file_ref(file_ref):
    """将前端 file 参数解析为真实绝对路径（支持工作目录内相对路径 + 外部 token）。"""
    if not file_ref or not isinstance(file_ref, str):
        abort(400, "Missing file parameter")
    if file_ref.startswith(EXTERNAL_REF_PREFIX):
        return _decode_external_ref(file_ref)
    return _safe_path(os.path.join(BASE_DIR, file_ref))


def _file_ref_from_abs_path(abs_path):
    """将绝对路径转换为前端可使用的 file 参数。"""
    abs_path = os.path.abspath(abs_path)
    if _is_under_base_dir(abs_path):
        return os.path.relpath(abs_path, BASE_DIR)
    return _encode_external_ref(abs_path)


def _display_path(abs_path):
    """用于页面和记录展示的路径。"""
    abs_path = os.path.abspath(abs_path)
    if _is_under_base_dir(abs_path):
        return os.path.relpath(abs_path, BASE_DIR)
    return abs_path


def _parse_local_pdf_path(raw_value):
    """解析用户输入的本地 PDF 路径（支持 file:// URI）。"""
    if raw_value is None:
        raise ValueError("缺少路径参数")

    raw = str(raw_value).strip()
    if not raw:
        raise ValueError("路径不能为空")

    # 兼容 uri-list 多行格式（忽略空行和注释行）
    if "\n" in raw or "\r" in raw:
        lines = [line.strip() for line in raw.replace("\r", "\n").split("\n")]
        lines = [line for line in lines if line and not line.startswith("#")]
        if not lines:
            raise ValueError("未解析到有效路径")
        raw = lines[0]

    # 兼容用户从终端复制的带引号路径，如 '/Users/me/book.pdf'
    if len(raw) >= 2:
        quote_pairs = {
            "'": "'",
            '"': '"',
            "‘": "’",
            "“": "”",
        }
        end_quote = quote_pairs.get(raw[0])
        if end_quote and raw.endswith(end_quote):
            raw = raw[1:-1].strip()

    if raw.startswith("file://"):
        parsed = urlparse(raw)
        if parsed.scheme != "file":
            raise ValueError("仅支持本地 file:// 路径")
        if parsed.netloc and parsed.netloc not in ("", "localhost"):
            raise ValueError("仅支持本机文件路径")
        path = unquote(parsed.path or "")
        # Windows 路径兼容：/C:/Users/... -> C:/Users/...
        if re.match(r"^/[A-Za-z]:/", path):
            path = path[1:]
        raw = path

    raw = os.path.expanduser(raw)
    abs_path = os.path.abspath(raw)
    if not abs_path.lower().endswith(".pdf"):
        raise ValueError("请选择 PDF 文件")
    if not os.path.isfile(abs_path):
        raise ValueError(f"文件不存在: {abs_path}")
    return abs_path


def _load_last_opened():
    """读取最近打开时间记录。"""
    if not os.path.exists(LAST_OPENED_FILE):
        return {}
    try:
        with open(LAST_OPENED_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_last_opened(data):
    """写入最近打开时间记录。"""
    tmp_path = LAST_OPENED_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, LAST_OPENED_FILE)


def _record_last_opened(rel_path):
    """记录某个 PDF 的最近打开时间。"""
    data = _load_last_opened()
    data[rel_path] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _save_last_opened(data)


def _outline_tree_to_flat(nodes, total_pages, level=1):
    """将树形目录转换为 fitz.set_toc 所需的扁平结构并做基础校验。"""
    if not isinstance(nodes, list):
        raise ValueError("outline 必须是数组")

    flat = []
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("目录项格式错误")

        title = str(node.get("title", "")).strip()
        if not title:
            raise ValueError("目录标题不能为空")

        try:
            page = int(node.get("page"))
        except Exception as e:
            raise ValueError(f"目录页码无效: {title}") from e

        if page < 1 or page > total_pages:
            raise ValueError(f"目录页码超出范围: {title} (1-{total_pages})")

        flat.append([level, title, page])
        children = node.get("children", [])
        if children:
            flat.extend(_outline_tree_to_flat(children, total_pages, level + 1))

    return flat


# ──────────────────────────────────────────────
# 页面路由
# ──────────────────────────────────────────────

@app.route("/")
def index():
    """首页：列出当前目录及子目录下的 PDF 文件。"""
    last_opened_map = _load_last_opened()
    seen = set()
    pdf_files = []
    for root, dirs, files in os.walk(BASE_DIR):
        # 跳过隐藏目录和常见非目标目录
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('__pycache__', 'node_modules', 'static', 'templates')]
        for f in sorted(files):
            if f.lower().endswith('.pdf'):
                full = os.path.join(root, f)
                rel = os.path.relpath(full, BASE_DIR)
                # 同一路径文件只显示一次（防御性去重）
                if rel in seen:
                    continue
                seen.add(rel)
                folder_rel = os.path.dirname(rel)
                pdf_files.append({
                    "relpath": rel,
                    "name": os.path.basename(rel),
                    "folder": folder_rel if folder_rel and folder_rel != "." else "根目录",
                    "last_opened": last_opened_map.get(rel, "未打开"),
                })
    pdf_files.sort(key=lambda x: (x["name"].lower(), x["folder"].lower(), x["relpath"].lower()))
    return render_template("index.html", pdf_files=pdf_files)


@app.route("/upload", methods=["POST"])
def upload():
    """上传本地 PDF 文件。"""
    if "file" not in request.files:
        return "No file uploaded", 400
    f = request.files["file"]
    if not f.filename or not f.filename.lower().endswith(".pdf"):
        return "请上传 PDF 文件", 400
    filename = secure_filename(f.filename)
    # 避免覆盖：若同名文件已存在则加序号
    save_path = os.path.join(BASE_DIR, filename)
    base, ext = os.path.splitext(filename)
    counter = 1
    while os.path.exists(save_path):
        filename = f"{base}_{counter}{ext}"
        save_path = os.path.join(BASE_DIR, filename)
        counter += 1
    f.save(save_path)
    return redirect(url_for("reader", file=filename))


@app.route("/open-external", methods=["POST"])
def open_external():
    """按本机绝对路径（或 file:// URI）打开 PDF，不复制到项目目录。"""
    data = request.get_json(silent=True) or {}
    raw_path = data.get("path") if data else None
    if raw_path is None:
        raw_path = request.form.get("path")

    try:
        abs_path = _parse_local_pdf_path(raw_path)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    file_ref = _file_ref_from_abs_path(abs_path)
    return jsonify({
        "success": True,
        "file": file_ref,
        "path": abs_path,
        "redirect": url_for("reader", file=file_ref),
    })


@app.route("/reader")
def reader():
    """阅读器页面。"""
    filepath = request.args.get("file", "")
    if not filepath:
        return "Missing file parameter", 400
    abs_path = _resolve_file_ref(filepath)
    if not os.path.isfile(abs_path):
        return f"File not found: {filepath}", 404
    _record_last_opened(_display_path(abs_path))
    return render_template("reader.html", filepath=filepath, filepath_display=_display_path(abs_path))


# ──────────────────────────────────────────────
# API 路由
# ──────────────────────────────────────────────

@app.route("/api/pdf")
def api_pdf():
    """返回 PDF 文件流。"""
    filepath = request.args.get("file", "")
    abs_path = _resolve_file_ref(filepath)
    if not os.path.isfile(abs_path):
        abort(404)
    resp = send_file(abs_path, mimetype="application/pdf")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.route("/api/outline")
def api_outline():
    """获取 PDF 的 outline/bookmarks，返回树形结构。"""
    filepath = request.args.get("file", "")
    abs_path = _resolve_file_ref(filepath)
    if not os.path.isfile(abs_path):
        abort(404)

    doc = fitz.open(abs_path)
    toc = doc.get_toc()  # [[level, title, page], ...]
    doc.close()

    # 构建树形结构
    def build_tree(flat_toc):
        root = []
        stack = [(0, root)]  # (level, children_list)
        for level, title, page in flat_toc:
            node = {"title": title, "page": page, "level": level, "children": []}
            # 找到合适的父节点
            while len(stack) > 1 and stack[-1][0] >= level:
                stack.pop()
            stack[-1][1].append(node)
            stack.append((level, node["children"]))
        return root

    tree = build_tree(toc)
    return jsonify({"outline": tree, "total": len(toc)})


@app.route("/api/extract-toc", methods=["POST"])
def api_extract_toc():
    """提取目录页面，返回临时 PDF 文件名。"""
    data = request.get_json()
    filepath = data.get("file", "")
    start_page = data.get("startPage")
    end_page = data.get("endPage")

    if not filepath or not start_page or not end_page:
        return jsonify({"error": "缺少参数"}), 400

    abs_path = _resolve_file_ref(filepath)
    if not os.path.isfile(abs_path):
        return jsonify({"error": "文件不存在"}), 404

    # 生成输出路径：同目录下 toc_extracted.pdf
    out_dir = os.path.dirname(abs_path)
    toc_pdf = os.path.join(out_dir, "toc_extracted.pdf")
    toc_ref = _file_ref_from_abs_path(toc_pdf)

    try:
        extract_toc_pages(abs_path, int(start_page), int(end_page), toc_pdf)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({"tocPdf": toc_ref})


@app.route("/api/add-toc", methods=["POST"])
def api_add_toc():
    """Gemini 解析目录 + 添加书签到原 PDF。"""
    data = request.get_json()
    filepath = data.get("file", "")
    toc_pdf_rel = data.get("tocPdf", "")
    page_offset = data.get("pageOffset", 0)

    abs_path = _resolve_file_ref(filepath)
    toc_pdf_path = _resolve_file_ref(toc_pdf_rel)

    if not os.path.isfile(abs_path):
        return jsonify({"error": "原 PDF 不存在"}), 404
    if not os.path.isfile(toc_pdf_path):
        return jsonify({"error": "目录 PDF 不存在"}), 404

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return jsonify({"error": "未配置 GEMINI_API_KEY"}), 500

    try:
        # Step 1: Gemini 解析
        toc_data = parse_toc_with_gemini(toc_pdf_path, api_key, "gemini-2.5-flash")

        # Step 2: 添加书签（先写临时文件再替换原文件）
        tmp_out = abs_path + ".tmp"
        add_bookmarks(abs_path, toc_data, tmp_out, int(page_offset))
        os.replace(tmp_out, abs_path)

        # Step 3: 删除临时目录 PDF
        os.remove(toc_pdf_path)

    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"success": True, "tocCount": len(toc_data["toc"])})


@app.route("/api/outline/save", methods=["POST"])
def api_save_outline():
    """保存前端编辑后的目录树到 PDF 书签。"""
    data = request.get_json(silent=True) or {}
    filepath = data.get("file", "")
    outline = data.get("outline", [])

    abs_path = _resolve_file_ref(filepath)
    if not os.path.isfile(abs_path):
        return jsonify({"error": "文件不存在"}), 404

    doc = None
    tmp_out = abs_path + ".tocsave.tmp.pdf"
    try:
        doc = fitz.open(abs_path)
        total_pages = len(doc)
        flat_toc = _outline_tree_to_flat(outline, total_pages)
        doc.set_toc(flat_toc)
        doc.save(tmp_out, garbage=3, deflate=True)
        doc.close()
        doc = None
        os.replace(tmp_out, abs_path)
    except ValueError as e:
        if doc is not None:
            doc.close()
        if os.path.exists(tmp_out):
            os.remove(tmp_out)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        if doc is not None:
            doc.close()
        if os.path.exists(tmp_out):
            os.remove(tmp_out)
        return jsonify({"error": f"保存目录失败: {e}"}), 500

    return jsonify({"success": True, "tocCount": len(flat_toc)})


@app.route("/api/top-chapters")
def api_top_chapters():
    """获取一级目录章节列表（用于拆分选择）。"""
    filepath = request.args.get("file", "")
    abs_path = _resolve_file_ref(filepath)
    if not os.path.isfile(abs_path):
        abort(404)

    toc = get_toc_from_bookmarks(abs_path)
    if not toc:
        return jsonify({"chapters": [], "error": "PDF 中没有书签"})

    chapters = find_top_level_chapters(toc)
    return jsonify({
        "chapters": [{"title": c["title"], "page": c["page"]} for c in chapters]
    })


@app.route("/api/split-chapters", methods=["POST"])
def api_split_chapters():
    """按选中的章节拆分 PDF。"""
    data = request.get_json()
    filepath = data.get("file", "")
    selected = data.get("chapters", [])  # [{"title": ..., "page": ...}, ...]

    abs_path = _resolve_file_ref(filepath)
    if not os.path.isfile(abs_path):
        return jsonify({"error": "文件不存在"}), 404

    if not selected:
        return jsonify({"error": "未选择任何章节"}), 400

    doc = fitz.open(abs_path)
    total_pages = len(doc)

    # 创建输出文件夹
    book_name = os.path.splitext(os.path.basename(abs_path))[0]
    book_name = re.sub(r'_(?:toc|bookmarked)$', '', book_name)
    output_dir = os.path.join(os.path.dirname(abs_path), book_name)
    os.makedirs(output_dir, exist_ok=True)

    # 按页码排序
    selected.sort(key=lambda c: c["page"])

    results = []
    for i, chapter in enumerate(selected):
        start_page = chapter["page"]
        if i + 1 < len(selected):
            end_page = selected[i + 1]["page"] - 1
        else:
            end_page = total_pages

        start_page = max(1, min(start_page, total_pages))
        end_page = max(start_page, min(end_page, total_pages))

        filename = sanitize_filename(chapter["title"]) + ".pdf"
        output_path = os.path.join(output_dir, filename)

        new_doc = fitz.open()
        new_doc.insert_pdf(doc, from_page=start_page - 1, to_page=end_page - 1)
        new_doc.save(output_path)
        new_doc.close()

        results.append({"title": chapter["title"], "file": filename, "pages": f"{start_page}-{end_page}"})

    doc.close()

    return jsonify({
        "success": True,
        "outputDir": _display_path(output_dir),
        "chapters": results
    })


if __name__ == "__main__":
    app.run(debug=True, port=3007)
