# MicroCompact + LLM 摘要压缩

## 两种本质不同的策略：

- Compaction(紧凑化): 不改变对话结构, 只缩小内容。
- Summarization(摘要化): 用 LLM 生成摘要替换整段对话，原始的这段对话内容会丢失。

我们原则: 先 Compaction 后 Summarization。
