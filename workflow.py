#!/usr/bin/env python3
"""
PDF 书籍处理完整工作流

步骤 1: 生成目录（提取目录页 → Gemini 解析 → 写入书签）
步骤 2: 拆分章节
步骤 3: 逐章总结

用法:
  # 完整流程
  python workflow.py --input book.pdf --steps 1-3 \\
    --toc-start 7 --toc-end 7 --page-offset 26 --prompt-type math

  # 只生成目录
  python workflow.py --input book.pdf --steps 1 \\
    --toc-start 7 --toc-end 7 --page-offset 26

  # 只逐章总结（需已有拆分好的章节文件夹）
  python workflow.py --input book.pdf --steps 3 \\
    --chapters-dir ./chapters --prompt-type math
"""

import argparse
import glob
import json
import os
import platform
import re
import subprocess
import sys

from dotenv import load_dotenv

# 导入已有模块的函数
from main import extract_toc_pages, parse_toc_with_gemini, add_bookmarks
from split_chapters import split_chapters, get_toc_from_bookmarks
from summarize import summarize_chapter, natural_sort_key, PROMPTS

load_dotenv()


# ══════════════════════════════════════════════
# 工具函数
# ══════════════════════════════════════════════

def open_file(path: str):
    """用系统默认应用打开文件。"""
    s = platform.system()
    if s == "Darwin":
        subprocess.Popen(["open", path])
    elif s == "Windows":
        os.startfile(path)
    else:
        subprocess.Popen(["xdg-open", path])


def confirm(prompt_text: str) -> bool:
    """终端交互确认，返回 True/False。"""
    while True:
        answer = input(f"\n{prompt_text} (y=确认 / n=终止): ").strip().lower()
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("请输入 y 或 n")


def parse_steps(steps_str: str) -> set:
    """解析步骤范围，如 '1-3' → {1,2,3}, '1' → {1}, '2-3' → {2,3}。"""
    m = re.match(r'^(\d+)(?:-(\d+))?$', steps_str.strip())
    if not m:
        print(f"错误: 无效的步骤格式: {steps_str}（示例: 1, 1-3, 2-3）")
        sys.exit(1)
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else start
    return set(range(start, end + 1))


# ══════════════════════════════════════════════
# 步骤 1: 生成目录
# ══════════════════════════════════════════════

def step1_generate_toc(input_pdf: str, toc_start: int, toc_end: int,
                       page_offset: int, api_key: str, model: str) -> str:
    """完成目录生成全流程，返回带书签的 PDF 路径。"""
    base, ext = os.path.splitext(input_pdf)
    toc_pdf = base + "_toc_pages.pdf"
    toc_json = base + "_toc.json"
    output_pdf = base + "_bookmarked" + ext

    # ── 1a: 提取目录页 ──
    print("\n" + "─" * 50)
    print("步骤 1a: 提取目录页")
    print("─" * 50)
    extract_toc_pages(input_pdf, toc_start, toc_end, toc_pdf)

    open_file(toc_pdf)
    if not confirm("请确认目录文档是否正确"):
        print("已终止。")
        sys.exit(0)

    # ── 1b: Gemini 解析目录 ──
    print("\n" + "─" * 50)
    print("步骤 1b: Gemini API 解析目录")
    print("─" * 50)
    toc_data = parse_toc_with_gemini(toc_pdf, api_key, model)

    with open(toc_json, "w", encoding="utf-8") as f:
        json.dump(toc_data, f, ensure_ascii=False, indent=2)
    print(f"解析完成，共 {len(toc_data['toc'])} 条 → {os.path.basename(toc_json)}")

    open_file(toc_json)
    if not confirm("请确认解析后的目录 JSON 是否正确（可先手动修改再确认）"):
        print("已终止。")
        sys.exit(0)

    # 重新读取（用户可能手动修改了 JSON）
    with open(toc_json, "r", encoding="utf-8") as f:
        toc_data = json.load(f)

    # ── 1c: 写入书签 ──
    print("\n" + "─" * 50)
    print("步骤 1c: 写入书签")
    print("─" * 50)
    add_bookmarks(input_pdf, toc_data, output_pdf, page_offset)

    open_file(output_pdf)
    if not confirm("请确认添加目录后的 PDF 是否合适"):
        print("已终止。")
        sys.exit(0)

    return output_pdf


# ══════════════════════════════════════════════
# 步骤 2: 拆分章节
# ══════════════════════════════════════════════

def step2_split_chapters(input_pdf: str) -> str:
    """按最外层章节拆分 PDF，返回章节文件夹路径。"""
    print("\n" + "─" * 50)
    print("步骤 2: 拆分章节")
    print("─" * 50)

    toc = get_toc_from_bookmarks(input_pdf)
    if not toc:
        print("错误: PDF 中没有书签，无法拆分。请先执行步骤 1。")
        sys.exit(1)

    book_name = os.path.splitext(os.path.basename(input_pdf))[0]
    book_name = re.sub(r'_bookmarked$', '', book_name)
    output_dir = os.path.join(os.path.dirname(input_pdf), book_name)

    os.makedirs(output_dir, exist_ok=True)
    split_chapters(input_pdf, toc, output_dir)

    open_file(output_dir)
    if not confirm("请确认章节划分是否正确"):
        print("已终止。")
        sys.exit(0)

    return output_dir


# ══════════════════════════════════════════════
# 步骤 3: 逐章总结
# ══════════════════════════════════════════════

def step3_summarize(chapters_dir: str, prompt_type: str,
                    api_key: str, model: str):
    """逐章上传 Gemini 生成 Markdown 总结。"""
    print("\n" + "─" * 50)
    print("步骤 3: 逐章总结")
    print("─" * 50)

    pdf_files = sorted(glob.glob(os.path.join(chapters_dir, "*.pdf")), key=natural_sort_key)
    if not pdf_files:
        print(f"错误: {chapters_dir} 中没有 PDF 文件")
        sys.exit(1)

    summary_dir = os.path.normpath(chapters_dir) + "_summary"
    os.makedirs(summary_dir, exist_ok=True)

    prompt = PROMPTS[prompt_type]
    total = len(pdf_files)

    print(f"共 {total} 个章节")
    print(f"Prompt 类型: {prompt_type}")
    print(f"模型: {model}")
    print(f"输出文件夹: {summary_dir}")

    if not confirm(f"是否同意调用 Gemini API 上传 {total} 个 PDF 进行逐章总结"):
        print("已终止。")
        sys.exit(0)

    for i, pdf_path in enumerate(pdf_files, start=1):
        filename = os.path.basename(pdf_path)
        md_name = os.path.splitext(filename)[0] + ".md"
        md_path = os.path.join(summary_dir, md_name)

        if os.path.isfile(md_path):
            print(f"  [{i}/{total}] 已存在，跳过: {md_name}")
            continue

        print(f"  [{i}/{total}] 处理中: {filename} ...", end=" ", flush=True)

        try:
            summary = summarize_chapter(pdf_path, api_key, model, prompt)
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(summary)
            print(f"完成 → {md_name}")
        except Exception as e:
            print(f"失败: {e}")
            print(f"\n已完成 {i-1}/{total}，可修复后重新运行（已有文件会自动跳过）。")
            sys.exit(1)

    print(f"\n全部完成！总结保存在: {summary_dir}")


# ══════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="PDF 书籍处理工作流: 生成目录(1) → 拆分章节(2) → 逐章总结(3)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
示例:
  完整流程:   python workflow.py --input book.pdf --steps 1-3 --toc-start 7 --toc-end 7 --page-offset 26 --prompt-type math
  只生成目录: python workflow.py --input book.pdf --steps 1 --toc-start 7 --toc-end 7 --page-offset 26
  只拆分章节: python workflow.py --input book.pdf --steps 2
  只逐章总结: python workflow.py --input book.pdf --steps 3 --chapters-dir ./chapters --prompt-type math
        """,
    )
    parser.add_argument("--input", required=True, help="原书 PDF 文件路径")
    parser.add_argument("--steps", required=True,
                        help="执行步骤: 1=生成目录, 2=拆分章节, 3=逐章总结, 1-3=全部")

    # 步骤 1 参数
    parser.add_argument("--toc-start", type=int, help="目录起始页码（从 1 计）")
    parser.add_argument("--toc-end", type=int, help="目录结束页码（从 1 计）")
    parser.add_argument("--page-offset", type=int, default=0,
                        help="印刷页码→PDF页码偏移量（PDF页码 = 印刷页码 + offset）")

    # 步骤 3 参数
    parser.add_argument("--prompt-type", choices=PROMPTS.keys(),
                        help="总结 Prompt 类型: math / business / other")
    parser.add_argument("--chapters-dir", default=None,
                        help="章节 PDF 文件夹（步骤 3 单独运行时需指定）")

    # 通用参数
    parser.add_argument("--model", default="gemini-2.5-flash",
                        help="Gemini 模型名（默认 gemini-2.5-flash）")

    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"错误: 文件不存在: {args.input}")
        sys.exit(1)

    steps = parse_steps(args.steps)

    if 1 in steps:
        if args.toc_start is None or args.toc_end is None:
            print("错误: 步骤 1 需要 --toc-start 和 --toc-end")
            sys.exit(1)

    if 3 in steps and args.prompt_type is None:
        print("错误: 步骤 3 需要 --prompt-type")
        sys.exit(1)

    api_key = None
    if 1 in steps or 3 in steps:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            print("错误: 未设置 GEMINI_API_KEY 环境变量（可在 .env 文件中配置）")
            sys.exit(1)

    print("=" * 50)
    print("PDF 书籍处理工作流")
    print(f"书籍: {os.path.basename(args.input)}")
    print(f"执行步骤: {sorted(steps)}")
    print("=" * 50)

    bookmarked_pdf = args.input
    chapters_dir = args.chapters_dir

    if 1 in steps:
        bookmarked_pdf = step1_generate_toc(
            args.input, args.toc_start, args.toc_end,
            args.page_offset, api_key, args.model
        )

    if 2 in steps:
        chapters_dir = step2_split_chapters(bookmarked_pdf)

    if 3 in steps:
        if chapters_dir is None:
            print("错误: 步骤 3 需要先执行步骤 2，或通过 --chapters-dir 指定章节文件夹")
            sys.exit(1)
        step3_summarize(chapters_dir, args.prompt_type, api_key, args.model)

    print("\n" + "=" * 50)
    print("工作流完成！")
    print("=" * 50)


if __name__ == "__main__":
    main()
