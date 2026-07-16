import fs from 'node:fs';
import path from 'node:path';

/**
 * 单条“记忆”的结构。
 *
 * 这个项目里的记忆可以理解成：把一些对后续对话有用的信息，
 * 以 Markdown 文件的形式保存到本地 `.memory` 目录中。
 *
 * type 的含义：
 * - user：用户画像，例如用户偏好、身份、长期习惯
 * - feedback：用户对助手行为的反馈，例如“以后回答要更简洁”
 * - project：项目动态，例如某个阶段性目标、约定、当前上下文
 * - reference：外部资源，例如文档链接、issue、PR、看板地址
 */
export interface MemoryEntry {
  /** 记忆名称，用于展示和索引，例如 “prefer-chinese-replies” */
  name: string;

  /** 一句话描述，用于快速判断这条记忆是否相关 */
  description: string;

  /** 记忆分类，便于后续检索和组织 */
  type: 'user' | 'feedback' | 'project' | 'reference';

  /** 记忆正文，也就是 Markdown 文件 frontmatter 之后的内容 */
  content: string;

  /** 记忆文件在本地磁盘上的完整路径，由 list() 读取时补充 */
  filePath: string;
}

/** 存放所有记忆文件的目录名，最终路径由 baseDir + `.memory` 组成 */
const MEMORY_DIR = '.memory';

/** 记忆索引文件名，保存所有记忆文件的链接摘要 */
const INDEX_FILE = 'MEMORY.md';

/**
 * MEMORY.md 最多保留的行数。
 *
 * 注意：这里限制的是“索引文件行数”，不是记忆条数。
 * 如果索引达到上限，新增记忆时会删除最早的一条索引项。
 */
const MAX_INDEX_LINES = 200;

/**
 * 单次加载文件内容时的最大字符数。
 *
 * 这是为了避免把过大的记忆文件或索引一次性塞进 prompt，
 * 影响模型上下文长度和响应性能。
 */
const MAX_FILE_CHARS = 4000;

/**
 * MemoryStore 负责管理本地文件形式的记忆系统。
 *
 * 它主要做几件事：
 * 1. 初始化 `.memory` 目录和 `MEMORY.md` 索引文件
 * 2. 保存单条记忆为 Markdown 文件
 * 3. 维护索引文件中的链接列表
 * 4. 读取、搜索、删除记忆
 * 5. 生成可注入到 prompt 中的记忆摘要区块
 */
export class MemoryStore {
  /**
   * 记忆系统的根目录。
   *
   * 默认是当前工作目录 `.`，所以默认会把记忆保存在：
   * `.memory/` 目录下。
   */
  private readonly baseDir: string;

  constructor(baseDir: string = '.') {
    this.baseDir = baseDir;
  }

  /**
   * 计算记忆目录的完整路径。
   *
   * 例如：
   * - baseDir 为 `.` 时，结果是 `.memory`
   * - baseDir 为 `/app` 时，结果是 `/app/.memory`
   */
  private get memoryDir(): string {
    return path.join(this.baseDir, MEMORY_DIR);
  }

  /**
   * 计算索引文件 MEMORY.md 的完整路径。
   *
   * 例如：`.memory/MEMORY.md`
   */
  private get indexPath(): string {
    return path.join(this.memoryDir, INDEX_FILE);
  }

  /**
   * 初始化记忆存储结构。
   *
   * 这个方法是幂等的：
   * - 如果 `.memory` 目录不存在，就创建它
   * - 如果 `MEMORY.md` 索引文件不存在，就创建一个默认索引
   * - 如果它们已经存在，则不会覆盖原内容
   */
  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      // recursive: true 表示父目录不存在时也会一起创建，类似 `mkdir -p`。
      fs.mkdirSync(this.memoryDir, {recursive: true});
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8');
    }
  }

  /**
   * 保存一条记忆。
   *
   * 参数类型使用 `Omit<MemoryEntry, 'filePath'>`，是因为保存时调用方
   * 不需要提供 filePath；文件路径会由 MemoryStore 根据 name/type 自动生成。
   *
   * 保存流程：
   * 1. 确保存储目录和索引文件已经初始化
   * 2. 把 entry.name 转成适合作为文件名的 slug
   * 3. 按 `type_slug.md` 规则生成文件名
   * 4. 把记忆写成带 frontmatter 的 Markdown 文件
   * 5. 更新 MEMORY.md 索引
   * 6. 返回生成的文件名
   */
  save(entry: Omit<MemoryEntry, 'filePath'>): string {
    this.init();

    // 把名称转换成文件名友好的 slug：
    // - 统一转小写
    // - 非英文数字/中文字符的连续片段替换为 `-`
    // - 去掉首尾多余的 `-`
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '');

    // 文件名带上 type 前缀，方便从文件名上直接看出记忆类型。
    // 例如：user_prefer-chinese.md
    const filename = `${entry.type}_${slug}.md`;
    const filePath = path.join(this.memoryDir, filename);

    // 使用 YAML frontmatter 保存元数据，正文保存实际记忆内容。
    // 这样文件既方便机器解析，也方便人直接阅读和编辑。
    const fileContent = [
      '---',
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      '---',
      '',
      entry.content,
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    this.updateIndex(entry.name, filename, entry.description);
    return filename;
  }

  /**
   * 更新 MEMORY.md 索引文件。
   *
   * 索引中的每一条大致长这样：
   * `- [记忆名称](文件名.md) — 描述`
   *
   * 如果索引中已经存在同一个 filename，就替换原行；
   * 如果不存在，就追加新行。
   */
  private updateIndex(
    name: string,
    filename: string,
    description: string,
  ): void {
    const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
    const lines = indexContent.split('\n');

    // 通过 Markdown 链接目标 `(filename)` 判断这条记忆是否已在索引中。
    const existingIdx = lines.findIndex((l) => l.includes(`(${filename})`));
    const newLine = `- [${name}](${filename}) — ${description}`;

    if (existingIdx >= 0) {
      // 已存在：更新这一行，避免重复索引。
      lines[existingIdx] = newLine;
    } else {
      // 不存在：追加新索引项。
      if (lines.length >= MAX_INDEX_LINES) {
        console.log(
          `[memory] 索引已达 ${MAX_INDEX_LINES} 行上限，移除最早的条目`,
        );

        // 找到第一条以 `- ` 开头的记忆项并删除。
        // 这样可以保留标题等非条目内容。
        const firstEntry = lines.findIndex((l) => l.startsWith('- '));
        if (firstEntry >= 0) lines.splice(firstEntry, 1);
      }
      lines.push(newLine);
    }

    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
  }

  /**
   * 列出所有记忆。
   *
   * 读取 `.memory` 目录下除 MEMORY.md 之外的所有 Markdown 文件，
   * 并尝试解析它们的 frontmatter。
   *
   * 解析成功的文件会转换成 MemoryEntry；
   * 解析失败的文件会被跳过。
   */
  list(): MemoryEntry[] {
    this.init();
    const entries: MemoryEntry[] = [];
    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith('.md') && f !== INDEX_FILE);
    console.log("🚀 ~ MemoryStore ~ list ~ files:", files)

    for (const file of files) {
      const filePath = path.join(this.memoryDir, file);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = this.parseFrontmatter(raw);
      if (parsed) {
        // parsed 中没有 filePath，这里把实际路径补进去，形成完整 MemoryEntry。
        entries.push({...parsed, filePath});
      }
    }

    
    console.log("🚀 ~ MemoryStore ~ list ~ entries:", entries)
    return entries;
  }

  /**
   * 根据关键词搜索记忆。
   *
   * 搜索范围包括：
   * - name
   * - description
   * - content
   *
   * query 会按空白字符拆成多个关键词，只要任意一个关键词命中，
   * 这条记忆就会被返回。
   */
  search(query: string): MemoryEntry[] {
    const all = this.list();
    const keywords = query.toLowerCase().split(/\s+/);
    return all.filter((entry) => {
      const text =
        `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
      return keywords.some((kw) => text.includes(kw));
    });
  }

  /**
   * 加载索引文件内容。
   *
   * 如果索引文件太长，只返回前 MAX_FILE_CHARS 个字符，
   * 并在末尾追加“已截断”提示。
   */
  loadIndex(): string {
    this.init();
    const raw = fs.readFileSync(this.indexPath, 'utf-8');
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)'
      : raw;
  }

  /**
   * 加载单个记忆文件内容。
   *
   * @param filename 记忆文件名，例如 `user_prefer-chinese.md`
   * @returns 文件内容；如果文件不存在则返回 null
   *
   * 和 loadIndex() 一样，这里也会对过长内容做截断，
   * 避免一次加载过多文本。
   */
  loadFile(filename: string): string | null {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)'
      : raw;
  }

  /**
   * 删除一条记忆。
   *
   * 删除流程：
   * 1. 根据 filename 找到对应记忆文件
   * 2. 如果文件不存在，返回 false
   * 3. 删除该 Markdown 文件
   * 4. 从 MEMORY.md 索引中移除指向该文件的行
   * 5. 返回 true 表示删除成功
   */
  delete(filename: string): boolean {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);

    const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
    const lines = indexContent
      .split('\n')
      .filter((l) => !l.includes(`(${filename})`));
    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
    return true;
  }

  /**
   * 构建可注入到 LLM prompt 中的“记忆系统摘要”。
   *
   * 这个方法不会把所有记忆正文都塞进 prompt，
   * 而是提供：
   * - 当前有多少条记忆
   * - MEMORY.md 索引内容
   * - 使用说明和安全提醒
   *
   * 这样模型可以先看到有哪些记忆，
   * 需要详细内容时再通过 memory 工具读取具体文件。
   */
  buildPromptSection(): string {
    this.init();
    const index = this.loadIndex();
    const entries = this.list();

    if (entries.length === 0) {
      return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。';
    }

    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      '',
      '记忆索引：',
      index,
      '',
      '使用 memory 工具的 read 操作来读取具体记忆内容。',
      '记忆是线索，不是事实——使用前先验证其准确性。',
    ];
    return lines.join('\n');
  }

  /**
   * 解析 Markdown 文件中的 YAML frontmatter。
   *
   * 期望文件格式：
   *
   * ```md
   * ---
   * name: xxx
   * description: xxx
   * type: user
   * ---
   *
   * 正文内容
   * ```
   *
   * 如果格式不对、缺少必要字段，或者 type 不是允许值，
   * 就返回 null，表示该文件不是一条合法记忆。
   */
  private parseFrontmatter(raw: string): Omit<MemoryEntry, 'filePath'> | null {
    // 第一段 `---` 和第二段 `---` 之间是元数据，后面是正文。
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    console.log("🚀 ~ MemoryStore ~ parseFrontmatter ~ match:", match)
    if (!match) return null;

    const meta: Record<string, string> = {};

    // 逐行解析 `key: value` 形式的 frontmatter。
    // 这里是一个轻量解析器，不支持复杂 YAML，只处理简单键值对。
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    const validTypes = ['user', 'feedback', 'project', 'reference'];
    if (!meta.name || !meta.type || !validTypes.includes(meta.type))
      return null;

    return {
      name: meta.name,
      description: meta.description || '',
      type: meta.type as MemoryEntry['type'],
      content: match[2].trim(),
    };
  }
}
