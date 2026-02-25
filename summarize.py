#!/usr/bin/env python3
"""
PDF 章节批量总结工具

给定章节 PDF 文件夹，按章节顺序逐个上传至 Gemini API，返回 Markdown 总结。

用法:
  python summarize.py --input-dir ./chapters --prompt-type math
  python summarize.py --input-dir ./chapters --prompt-type business --model gemini-2.5-pro
"""

import argparse
import glob
import os
import re
import sys
import time

from dotenv import load_dotenv

load_dotenv()

# ──────────────────────────────────────────────
# Prompt 模板（请在此处填写实际内容）
# ──────────────────────────────────────────────

PROMPTS = {
    "math": """\
TODO: 在此填写数学类书籍的总结 prompt
""",

    "business": """\
TODO: 在此填写商业类书籍的总结 prompt
""",

    "other": """\
TODO: 在此填写其他类书籍的总结 prompt
""",
}


def natural_sort_key(path: str):
    """自然排序：按文件名中的数字排序（1, 2, 10 而非 1, 10, 2）。"""
    name = os.path.basename(path)
    return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', name)]


def summarize_chapter(pdf_path: str, api_key: str, model_name: str, prompt: str) -> str:
    """上传单个章节 PDF 到 Gemini，返回 Markdown 总结文本。"""
    import google.generativeai as genai

    genai.configure(api_key=api_key)

    uploaded = genai.upload_file(pdf_path, mime_type="application/pdf")

    # 等待文件处理完成
    while uploaded.state.name == "PROCESSING":
        time.sleep(2)
        uploaded = genai.get_file(uploaded.name)

    if uploaded.state.name == "FAILED":
        raise RuntimeError(f"文件处理失败: {pdf_path}")

    model = genai.GenerativeModel(model_name)
    response = model.generate_content([uploaded, prompt])

    # 清理上传的文件
    try:
        genai.delete_file(uploaded.name)
    except Exception:
        pass

    return response.text


def main():
    parser = argparse.ArgumentParser(
        description="批量上传章节 PDF 至 Gemini 获取总结",
    )
    parser.add_argument("--input-dir", required=True, help="章节 PDF 所在文件夹")
    parser.add_argument("--output-dir", default=None,
                        help="输出 Markdown 文件夹（默认与 input-dir 同级的 <书名>_summary）")
    parser.add_argument("--prompt-type", required=True, choices=PROMPTS.keys(),
                        help="Prompt 类型: math / business / other")
    parser.add_argument("--model", default="gemini-2.5-flash",
                        help="Gemini 模型名（默认 gemini-2.5-flash）")
    parser.add_argument("--start-from", type=int, default=1,
                        help="从第几个文件开始（用于断点续传，默认 1）")

    args = parser.parse_args()

    if not os.path.isdir(args.input_dir):
        print(f"错误: 文件夹不存在: {args.input_dir}")
        sys.exit(1)

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("错误: 未设置 GEMINI_API_KEY 环境变量（可在 .env 文件中配置）")
        sys.exit(1)

    # 收集并排序 PDF 文件
    pdf_files = sorted(glob.glob(os.path.join(args.input_dir, "*.pdf")), key=natural_sort_key)
    if not pdf_files:
        print(f"错误: {args.input_dir} 中没有 PDF 文件")
        sys.exit(1)

    # 输出文件夹
    if args.output_dir is None:
        parent = os.path.dirname(os.path.normpath(args.input_dir))
        book_name = os.path.basename(os.path.normpath(args.input_dir))
        args.output_dir = os.path.join(parent, f"{book_name}_summary")

    os.makedirs(args.output_dir, exist_ok=True)

    prompt = PROMPTS[args.prompt_type]
    total = len(pdf_files)

    print(f"共 {total} 个章节 PDF")
    print(f"Prompt 类型: {args.prompt_type}")
    print(f"模型: {args.model}")
    print(f"输出文件夹: {args.output_dir}")
    print(f"从第 {args.start_from} 个文件开始")
    print("=" * 50)

    for i, pdf_path in enumerate(pdf_files, start=1):
        filename = os.path.basename(pdf_path)
        md_name = os.path.splitext(filename)[0] + ".md"
        md_path = os.path.join(args.output_dir, md_name)

        # 跳过断点续传之前的文件
        if i < args.start_from:
            print(f"  [{i}/{total}] 跳过: {filename}")
            continue

        # 跳过已存在的总结
        if os.path.isfile(md_path):
            print(f"  [{i}/{total}] 已存在，跳过: {md_name}")
            continue

        print(f"  [{i}/{total}] 处理中: {filename} ...", end=" ", flush=True)

        try:
            summary = summarize_chapter(pdf_path, api_key, args.model, prompt)
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(summary)
            print(f"完成 → {md_name}")
        except Exception as e:
            print(f"失败: {e}")
            print(f"    可用 --start-from {i} 从此处重试")
            sys.exit(1)

    print("\n" + "=" * 50)
    print(f"全部完成！总结文件保存在: {args.output_dir}")


if __name__ == "__main__":
    main()
