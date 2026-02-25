#!/usr/bin/env python3
"""
PDF 书籍目录提取与书签添加工具

工作流（分步执行，便于人工确认）：
  python main.py extract  --input book.pdf --toc-start 7 --toc-end 7
  python main.py parse    --toc-pdf toc_extracted.pdf
  python main.py apply    --input book.pdf --toc-json toc.json --page-offset 26
"""

import argparse
import json
import os
import sys
import time

import fitz  # pymupdf
from dotenv import load_dotenv

load_dotenv()

# ──────────────────────────────────────────────
# Step 1: 提取目录页
# ──────────────────────────────────────────────

def extract_toc_pages(input_pdf: str, start_page: int, end_page: int, output_pdf: str):
    """从原书 PDF 提取第 start_page ~ end_page 页（从 1 计），保存为独立 PDF。"""
    doc = fitz.open(input_pdf)
    total = len(doc)
    if start_page < 1 or end_page > total or start_page > end_page:
        doc.close()
        raise ValueError(f"页码范围无效: {start_page}-{end_page}（PDF 共 {total} 页）")

    new_doc = fitz.open()
    new_doc.insert_pdf(doc, from_page=start_page - 1, to_page=end_page - 1)
    new_doc.save(output_pdf)
    new_doc.close()
    doc.close()
    print(f"[Step 1] 已提取第 {start_page}-{end_page} 页 → {output_pdf}")


# ──────────────────────────────────────────────
# Step 3: Gemini API 解析目录
# ──────────────────────────────────────────────

GEMINI_PROMPT = """\
请从这份 PDF 中提取完整的书籍目录。

返回严格的 JSON，不要有任何其他文字或 markdown 标记：
{
  "toc": [
    {"level": 1, "title": "章节标题", "page": 页码数字},
    {"level": 2, "title": "小节标题", "page": 页码数字}
  ]
}

规则：
- level: 1=章/部分, 2=节, 3=小节（根据缩进或编号层级判断）
- page: 使用目录中显示的印刷页码数字
- title: 保留原文标题，不要翻译或修改
- 按目录中的顺序排列
"""


def parse_toc_with_gemini(toc_pdf_path: str, api_key: str, model_name: str) -> dict:
    """上传目录 PDF 到 Gemini，返回结构化目录 dict。"""
    import google.generativeai as genai

    genai.configure(api_key=api_key)

    print("[Step 3] 正在上传 PDF 到 Gemini...")
    uploaded = genai.upload_file(toc_pdf_path, mime_type="application/pdf")

    # 等待文件处理完成
    while uploaded.state.name == "PROCESSING":
        time.sleep(2)
        uploaded = genai.get_file(uploaded.name)

    if uploaded.state.name == "FAILED":
        raise RuntimeError(f"Gemini 文件处理失败: {uploaded.state.name}")

    print(f"[Step 3] 文件已上传，使用模型 {model_name} 解析中...")
    model = genai.GenerativeModel(model_name)
    response = model.generate_content([uploaded, GEMINI_PROMPT])

    # 清理可能的 markdown 代码块标记
    text = response.text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1]  # 去掉第一行 ```json
    if text.endswith("```"):
        text = text[:-3].strip()

    toc_data = json.loads(text)

    # 基本校验
    if "toc" not in toc_data or not isinstance(toc_data["toc"], list):
        raise ValueError("Gemini 返回的 JSON 缺少 toc 数组")
    for i, item in enumerate(toc_data["toc"]):
        for key in ("level", "title", "page"):
            if key not in item:
                raise ValueError(f"toc[{i}] 缺少字段: {key}")

    # 清理上传的文件
    try:
        genai.delete_file(uploaded.name)
    except Exception:
        pass

    print(f"[Step 3] 解析完成，共 {len(toc_data['toc'])} 条目录条目")
    return toc_data


# ──────────────────────────────────────────────
# Step 5: 写入书签
# ──────────────────────────────────────────────

def add_bookmarks(input_pdf: str, toc_data: dict, output_pdf: str, page_offset: int):
    """
    根据结构化目录向 PDF 添加书签。

    page_offset: PDF 实际页码 = 印刷页码 + page_offset
    例如：印刷第 3 页 对应 PDF 第 29 页 → page_offset = 26
    """
    doc = fitz.open(input_pdf)
    total_pages = len(doc)

    toc_list = []
    for item in toc_data["toc"]:
        level = item["level"]
        title = item["title"]
        pdf_page = item["page"] + page_offset

        # 确保页码在有效范围内
        if pdf_page < 1:
            pdf_page = 1
        elif pdf_page > total_pages:
            pdf_page = total_pages

        toc_list.append([level, title, pdf_page])

    doc.set_toc(toc_list)
    doc.save(output_pdf)
    doc.close()
    print(f"[Step 5] 已添加 {len(toc_list)} 条书签 → {output_pdf}")


# ──────────────────────────────────────────────
# CLI: 子命令
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="PDF 书籍目录提取与书签添加工具（分步执行）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
分步使用:
  1. 提取目录页:  python main.py extract --input book.pdf --toc-start 7 --toc-end 7
     → 生成 toc_extracted.pdf，人工检查
  2. Gemini 解析: python main.py parse --toc-pdf toc_extracted.pdf
     → 生成 toc.json，人工检查
  3. 写入书签:    python main.py apply --input book.pdf --toc-json toc.json --page-offset 26
     → 生成 book_toc.pdf
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── extract ──
    p_ext = sub.add_parser("extract", help="从原书提取目录页")
    p_ext.add_argument("--input", required=True, help="原书 PDF 文件路径")
    p_ext.add_argument("--toc-start", type=int, required=True, help="目录起始页码（从 1 计）")
    p_ext.add_argument("--toc-end", type=int, required=True, help="目录结束页码（从 1 计）")
    p_ext.add_argument("--toc-pdf", default="toc_extracted.pdf", help="输出路径（默认 toc_extracted.pdf）")

    # ── parse ──
    p_parse = sub.add_parser("parse", help="用 Gemini API 解析目录 PDF → JSON")
    p_parse.add_argument("--toc-pdf", default="toc_extracted.pdf", help="目录 PDF 路径")
    p_parse.add_argument("--toc-json", default="toc.json", help="输出 JSON 路径（默认 toc.json）")
    p_parse.add_argument("--model", default="gemini-2.5-flash", help="Gemini 模型名（默认 gemini-2.5-flash）")

    # ── apply ──
    p_apply = sub.add_parser("apply", help="根据 JSON 目录向 PDF 写入书签")
    p_apply.add_argument("--input", required=True, help="原书 PDF 文件路径")
    p_apply.add_argument("--toc-json", default="toc.json", help="目录 JSON 路径（默认 toc.json）")
    p_apply.add_argument("--page-offset", type=int, default=0,
                         help="印刷页码→PDF页码偏移量（PDF页码 = 印刷页码 + offset）")
    p_apply.add_argument("--output", default=None, help="输出 PDF 路径（默认原文件名_toc.pdf）")

    args = parser.parse_args()

    if args.command == "extract":
        if not os.path.isfile(args.input):
            print(f"错误: 文件不存在: {args.input}")
            sys.exit(1)
        extract_toc_pages(args.input, args.toc_start, args.toc_end, args.toc_pdf)
        print(f"\n请检查 {args.toc_pdf}，确认无误后运行 parse 步骤。")

    elif args.command == "parse":
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            print("错误: 未设置 GEMINI_API_KEY 环境变量（可在 .env 文件中配置）")
            sys.exit(1)
        if not os.path.isfile(args.toc_pdf):
            print(f"错误: 文件不存在: {args.toc_pdf}")
            sys.exit(1)

        toc_data = parse_toc_with_gemini(args.toc_pdf, api_key, args.model)
        with open(args.toc_json, "w", encoding="utf-8") as f:
            json.dump(toc_data, f, ensure_ascii=False, indent=2)
        print(f"目录 JSON 已保存 → {args.toc_json}")
        print(f"\n请检查 {args.toc_json}，确认无误后运行 apply 步骤。")

    elif args.command == "apply":
        if not os.path.isfile(args.input):
            print(f"错误: 文件不存在: {args.input}")
            sys.exit(1)
        if not os.path.isfile(args.toc_json):
            print(f"错误: 文件不存在: {args.toc_json}")
            sys.exit(1)

        with open(args.toc_json, "r", encoding="utf-8") as f:
            toc_data = json.load(f)

        if args.output is None:
            base, ext = os.path.splitext(args.input)
            args.output = f"{base}_toc{ext}"

        add_bookmarks(args.input, toc_data, args.output, args.page_offset)
        print(f"\n完成！输出文件: {args.output}")


if __name__ == "__main__":
    main()
