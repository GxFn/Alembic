import { Capability } from './Capability.js';

interface SystemInteractionOpts {
  projectRoot?: string;
}

export class SystemInteraction extends Capability {
  #projectRoot;

  constructor(opts: SystemInteractionOpts = {}) {
    super();
    this.#projectRoot = opts.projectRoot || process.cwd();
  }

  get name() {
    return 'system_interaction';
  }

  get promptFragment() {
    return `## 系统交互能力
你可以在本地环境中执行结构化终端命令、写入文件、探索项目，并读取受治理的本机 macOS 状态。

V2 工具系统（资源导向，6 个核心工具）:
1. **code** — 代码读写搜索: code({ action: "read/search/write/outline/structure" })
2. **terminal** — 命令执行: terminal({ action: "exec", command: "..." })
3. **knowledge** — 知识提交/搜索: knowledge({ action: "submit/search" })
4. **graph** — 代码图谱查询: graph({ action: "query", ... })
5. **memory** — 会话记忆: memory({ action: "save/recall" })
6. **meta** — 自省: meta({ action: "tools/status" })

安全规则:
- 所有操作限制在项目目录 (${this.#projectRoot}) 内
- terminal 命令经过安全检查（危险命令自动拦截）
- 受保护文件 (.git/, node_modules/, .env) 不可写入
- SafetyPolicy 可进一步约束可执行命令和可访问路径

项目路径: ${this.#projectRoot}`;
  }

  get tools() {
    return ['code', 'terminal', 'knowledge', 'graph', 'memory', 'meta'];
  }
}
