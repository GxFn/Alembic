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

能力:
1. **终端命令**: terminal 执行结构化命令，参数为 { bin, args, env, cwd, timeoutMs, network, filesystem, interactive, session }
   - interactive 默认为 "never"；当前不开放需要人工输入的交互式命令
   - env 默认为单次命令作用域；只有 persistent session 显式声明 envPersistence="explicit" 时才复用显式 env metadata
   - terminal_script 执行非交互 /bin/sh 脚本；脚本会先写入 artifact，并且每次都需要确认
   - terminal({ mode: "shell" }) 执行受治理的 /bin/sh -lc 命令字符串；适合必须使用管道/重定向/命令替换的场景
   - terminal_pty 通过 PTY wrapper 观察一次性 shell 命令 transcript；可提供有限的一次性 stdin，发送后立即关闭，不开放持续交互
   - terminal_session_status / terminal_session_close / terminal_session_cleanup 可查看、关闭或清理 persistent session metadata
2. **文件写入**: write_project_file 创建/覆盖项目内文件
3. **环境探测**: get_environment_info 获取 OS/Node/Git/项目信息
4. **项目探索**: 搜索代码、读取文件、列出目录结构
5. **macOS 本机能力**: mac_system_info / mac_permission_status / mac_window_list / mac_screenshot
   - permission status 只报告已知状态，不触发 TCC 授权请求，不绕过系统权限
   - window list 和 screenshot 使用 ScreenCaptureKit helper；窗口标题和图片按敏感 artifact/resource ref 处理

安全规则:
- 所有操作限制在项目目录 (${this.#projectRoot}) 内
- 终端命令必须拆成 bin + args，不接受自由 shell、管道、重定向或命令替换
- 多行脚本只能通过 terminal_script 执行；交互式显示需求使用 terminal_pty，但只支持一次性 bounded stdin，持续交互 shell 暂不开放
- 危险可执行文件 (sudo, dd, mkfs, shutdown 等) 和 rm -rf 会被自动拦截
- 受保护文件 (.git/, node_modules/, .env) 不可写入
- SafetyPolicy 可进一步约束可执行命令和可访问路径

最佳实践:
- 执行命令前先 get_environment_info 了解环境
- git 命令用于查看状态、diff、log，不建议执行 push/commit
- 需要执行命令时优先使用明确的 bin 和 args，例如 { "bin": "git", "args": ["status"] }

项目路径: ${this.#projectRoot}`;
  }

  get tools() {
    return [
      'terminal',
      'code',
      'terminal_script',
      'terminal_pty',
      'terminal_session_close',
      'terminal_session_status',
      'terminal_session_cleanup',
      'mac_system_info',
      'mac_permission_status',
      'mac_window_list',
      'mac_screenshot',
      'write_project_file',
      'get_environment_info',
      'list_project_structure',
      'get_project_overview',
      'get_file_summary',
    ];
  }
}
