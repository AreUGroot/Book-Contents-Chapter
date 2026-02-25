# PDF 书籍处理工具集

## 环境准备

```bash
# 安装依赖
pip3 install -r requirements.txt

# 配置 Gemini API Key
cp .env.example .env
# 编辑 .env 填入你的 API Key
```

## 工具一览

| 脚本 | 功能 |
|------|------|
| `workflow.py` | 整合工作流（推荐使用） |
| `main.py` | 单独执行目录相关操作 |
| `split_chapters.py` | 单独拆分章节 |
| `summarize.py` | 单独批量总结 |

---

## workflow.py — 整合工作流

三个步骤：生成目录(1) → 拆分章节(2) → 逐章总结(3)

### 完整流程 (1-3)

```bash
python workflow.py \
  --input "书籍路径.pdf" \
  --steps 1-3 \
  --toc-start 12 --toc-end 17 --page-offset 17 \
  --prompt-type math
```

### 只生成目录 (1)

```bash
python workflow.py \
  --input "书籍路径.pdf" \
  --steps 1 \
  --toc-start 7 --toc-end 7 --page-offset 26
```

### 只拆分章节 (2)

PDF 需已有书签。

```bash
python workflow.py \
  --input "带书签的书籍.pdf" \
  --steps 2
```

### 只逐章总结 (3)

需指定已拆分好的章节文件夹。

```bash
python workflow.py \
  --input "书籍路径.pdf" \
  --steps 3 \
  --chapters-dir "章节文件夹路径" \
  --prompt-type math
```

### 组合使用

```bash
# 目录 + 拆分
python workflow.py --input book.pdf --steps 1-2 \
  --toc-start 5 --toc-end 8 --page-offset 20

# 拆分 + 总结
python workflow.py --input book.pdf --steps 2-3 \
  --prompt-type business
```

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--input` | 是 | 原书 PDF 文件路径 |
| `--steps` | 是 | 执行步骤：`1` / `2` / `3` / `1-2` / `2-3` / `1-3` |
| `--toc-start` | 步骤1 | 目录起始页码（PDF 页码，从 1 计） |
| `--toc-end` | 步骤1 | 目录结束页码 |
| `--page-offset` | 步骤1 | 偏移量 = PDF实际页码 − 目录印刷页码 |
| `--prompt-type` | 步骤3 | Prompt 类型：`math` / `business` / `other` |
| `--chapters-dir` | 步骤3单独运行 | 章节 PDF 文件夹路径 |
| `--model` | 否 | Gemini 模型（默认 `gemini-2.5-flash`） |

### page-offset 计算方法

找到目录中任意一章的印刷页码，再找到该章在 PDF 中的实际页码：

```
page-offset = PDF实际页码 − 印刷页码
```

例：目录显示第1章在第 3 页，PDF 中实际在第 29 页 → `--page-offset 26`

### 人工确认点

运行过程中会在以下节点暂停，等待终端输入 `y` 确认：

1. 提取目录页后 — 确认目录文档是否正确
2. Gemini 解析后 — 确认 JSON 目录是否正确（可先手动修改再确认）
3. 写入书签后 — 确认带书签的 PDF 是否合适
4. 拆分章节后 — 确认章节划分是否正确
5. 开始总结前 — 确认是否同意调用 Gemini API

---

## main.py — 目录操作（分步）

```bash
# 提取目录页
python main.py extract --input book.pdf --toc-start 7 --toc-end 7

# Gemini 解析目录
python main.py parse --toc-pdf toc_extracted.pdf

# 写入书签
python main.py apply --input book.pdf --toc-json toc.json --page-offset 26
```

## split_chapters.py — 拆分章节

```bash
# 从 PDF 书签读取目录并拆分
python split_chapters.py --input book_bookmarked.pdf

# 从 JSON 读取目录并拆分
python split_chapters.py --input book.pdf --toc-json toc.json --page-offset 26
```

## summarize.py — 批量总结

```bash
python summarize.py \
  --input-dir "章节文件夹" \
  --prompt-type math \
  --model gemini-2.5-flash
```

支持断点续传：已有的 `.md` 文件会自动跳过。失败时可用 `--start-from N` 从指定位置重试。

---

## Prompt 模板

在 `summarize.py` 顶部的 `PROMPTS` 字典中编辑三种模板：

- `math` — 数学/理工类书籍
- `business` — 商业/社科类书籍
- `other` — 其他类型
