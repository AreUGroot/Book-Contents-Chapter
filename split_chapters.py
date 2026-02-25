#!/usr/bin/env python3
"""
PDF 书籍按章节拆分工具

根据 PDF 书签或 toc.json 将正文章节拆分为独立 PDF 文件。

用法:
  python split_chapters.py --input book.pdf
  python split_chapters.py --input book.pdf --toc-json toc.json --page-offset 26
"""

import argparse
import json
import os
import re
import sys

import fitz  # pymupdf


def get_toc_from_bookmarks(pdf_path: str) -> list[dict]:
    """从 PDF 书签中读取目录，返回 [{level, title, page}, ...]（page 为 PDF 页码）。"""
    doc = fitz.open(pdf_path)
    toc = doc.get_toc()  # [[level, title, page], ...]
    doc.close()
    if not toc:
        return []
    return [{"level": item[0], "title": item[1], "page": item[2]} for item in toc]


def get_toc_from_json(json_path: str, page_offset: int) -> list[dict]:
    """从 toc.json 读取目录，将印刷页码转为 PDF 页码。"""
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    result = []
    for item in data["toc"]:
        result.append({
            "level": item["level"],
            "title": item["title"],
            "page": item["page"] + page_offset,
        })
    return result


def sanitize_filename(name: str) -> str:
    """清理文件名中的非法字符。"""
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    name = name.strip('. ')
    return name[:100] if name else "untitled"


def find_top_level_chapters(toc: list[dict]) -> list[dict]:
    """
    找出最外层的正文章节。

    策略：找到目录中最小的 level 值对应的、带章节编号的条目。
    例如书签中 level 1 是 "1 From Complex..." 这类章标题，就只取 level 1。
    """
    # 匹配章节编号模式：数字开头、"Chapter X"、"第X章"
    chapter_pattern = re.compile(
        r'(^chapter\s+\d+|^第\s*\d+\s*章|^\d+\s)',
        re.IGNORECASE
    )

    # 找出所有带章节编号的条目
    numbered = [item for item in toc if chapter_pattern.search(item["title"].strip())]

    if not numbered:
        # 没有编号的，退回到最小 level
        min_level = min(item["level"] for item in toc)
        return [item for item in toc if item["level"] == min_level]

    # 取这些编号条目中最小的 level
    min_level = min(item["level"] for item in numbered)
    return [item for item in numbered if item["level"] == min_level]


def split_chapters(input_pdf: str, toc: list[dict], output_dir: str):
    """根据目录拆分最外层正文章节为独立 PDF。"""
    doc = fitz.open(input_pdf)
    total_pages = len(doc)

    chapters = find_top_level_chapters(toc)

    if not chapters:
        doc.close()
        print("错误: 目录中没有可用的章节条目。")
        sys.exit(1)

    print(f"共找到 {len(chapters)} 个正文章节，开始拆分...\n")

    for i, chapter in enumerate(chapters):
        start_page = chapter["page"]
        if start_page is None:
            continue

        # 结束页 = 下一章的起始页 - 1，最后一章直接到 PDF 末尾
        if i + 1 < len(chapters):
            end_page = chapters[i + 1]["page"] - 1
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

        print(f"  [{i+1}/{len(chapters)}] p{start_page}-{end_page} → {filename}")

    doc.close()
    print(f"\n完成！所有章节已保存到: {output_dir}")


def main():
    parser = argparse.ArgumentParser(
        description="按章节拆分 PDF 书籍",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--input", required=True, help="PDF 文件路径")
    parser.add_argument("--toc-json", default=None,
                        help="目录 JSON 文件路径（不指定则从 PDF 书签读取）")
    parser.add_argument("--page-offset", type=int, default=0,
                        help="仅在使用 --toc-json 时有效，印刷页码→PDF页码偏移量")
    parser.add_argument("--output-dir", default=None,
                        help="输出文件夹路径（默认以书名命名）")

    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"错误: 文件不存在: {args.input}")
        sys.exit(1)

    # 读取目录
    if args.toc_json:
        if not os.path.isfile(args.toc_json):
            print(f"错误: 文件不存在: {args.toc_json}")
            sys.exit(1)
        toc = get_toc_from_json(args.toc_json, args.page_offset)
        print(f"从 {args.toc_json} 读取目录，共 {len(toc)} 条")
    else:
        toc = get_toc_from_bookmarks(args.input)
        if not toc:
            print("错误: PDF 中没有书签。请用 --toc-json 指定目录文件。")
            sys.exit(1)
        print(f"从 PDF 书签读取目录，共 {len(toc)} 条")

    # 创建输出文件夹
    if args.output_dir is None:
        book_name = os.path.splitext(os.path.basename(args.input))[0]
        # 去掉常见后缀如 _toc
        book_name = re.sub(r'_toc$', '', book_name)
        args.output_dir = os.path.join(os.path.dirname(args.input), book_name)

    os.makedirs(args.output_dir, exist_ok=True)
    print(f"输出文件夹: {args.output_dir}\n")

    split_chapters(args.input, toc, args.output_dir)


if __name__ == "__main__":
    main()
