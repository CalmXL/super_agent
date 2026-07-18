---
name: deploy-process
description: 部署流程的关键步骤（完整文档见知识库 docs/deployment-guide.md）
type: project
lastWriteAt: 1784273237045
lastReadAt: 1784273237045
---

完整部署流程参见 docs/deployment-guide.md（已导入知识库，可用 rag_search 查询）。

执行顺序：
1. 拉代码、装依赖
2. 跑数据库迁移
3. 构建前端产物
4. 重启服务

注意：scripts/migrate.sh 和 scripts/deploy.sh 路径已失效，具体脚本路径需以实际仓库为准。