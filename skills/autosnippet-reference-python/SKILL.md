---
name: autosnippet-reference-python
description: Python 业界最佳实践参考。涵盖类型提示、模块组织、错误处理、异步编程、命名约定、上下文管理、推导式、数据类，为冷启动分析提供高质量参考标准。
---

# Python 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 Python 项目时，请参考以下业界标准产出高质量候选。
> **来源**: PEP 8, PEP 484, PEP 257, Google Python Style Guide, Real Python Best Practices

---

## 1. 模块与包结构

### 核心规则

```json
{
  "title": "Python: 使用 __all__ 控制模块公开 API",
  "content": {
    "markdown": "## Python: 使用 __all__ 控制模块公开 API\n\n### 标准模式\n```python\n# ✅ 明确定义公开 API\n__all__ = ['UserService', 'parse_config', 'MAX_RETRY']\n\nclass UserService:\n    ...\n\ndef parse_config(raw: str) -> Config:\n    ...\n\ndef _internal_helper():\n    \"\"\"以下划线开头表示内部函数\"\"\"\n    ...\n\nMAX_RETRY = 3\n```",
    "pattern": "# ✅ 明确定义公开 API\n__all__ = ['UserService', 'parse_config', 'MAX_RETRY']\n\nclass UserService:\n    ...\n\ndef parse_config(raw: str) -> Config:\n    ...\n\ndef _internal_helper():\n    \"\"\"以下划线开头表示内部函数\"\"\"\n    ...\n\nMAX_RETRY = 3",
    "rationale": "__all__ 明确控制 from module import * 的行为，便于 IDE 自动补全和文档生成"
  },
  "description": "Python: 使用 __all__ 控制模块公开 API",
  "kind": "rule",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: 使用 __all__ 控制模块公开 API的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "from utils import *  # 没有 __all__，导入所有公开名称",
    "why": "无法控制 API 边界，重构时容易意外暴露或破坏接口",
    "fix": "在模块中定义 __all__ 列表，只导出需要的名称"
  },
  "reasoning": {
    "whyStandard": "PEP 8 推荐使用 __all__ 来定义模块的公开接口",
    "sources": [
      "PEP 8 - Public and Internal Interfaces"
    ],
    "confidence": 0.9
  }
}
```

### 导入顺序

```json
{
  "title": "Python: PEP 8 / isort 标准导入顺序",
  "content": {
    "markdown": "## Python: PEP 8 / isort 标准导入顺序\n\n### 标准模式\n```python\n# ✅ 三段式导入，用空行分隔\n\n# 1. 标准库\nimport os\nimport sys\nfrom pathlib import Path\nfrom collections.abc import Sequence\n\n# 2. 第三方库\nimport fastapi\nfrom pydantic import BaseModel\nimport numpy as np  # 标准缩写\n\n# 3. 本地模块（使用完整包路径）\nfrom myproject.models import User\nfrom myproject.utils import parse_config\n\n# ❌ 避免相对导入（Google Style Guide）\nfrom .models import User  # 不推荐\n\n# ❌ 不要合并 import\nimport os, sys  # 每个 import 一行\n\n# ❌ 不要 import 具体类/函数（除 typing/collections.abc）\nfrom os.path import join  # 不推荐\nfrom os import path  # 推荐\n```",
    "pattern": "# ✅ 三段式导入，用空行分隔\n\n# 1. 标准库\nimport os\nimport sys\nfrom pathlib import Path\nfrom collections.abc import Sequence\n\n# 2. 第三方库\nimport fastapi\nfrom pydantic import BaseModel\nimport numpy as np  # 标准缩写\n\n# 3. 本地模块（使用完整包路径）\nfrom myproject.models import User\nfrom myproject.utils import parse_config\n\n# ❌ 避免相对导入（Google Style Guide）\nfrom .models import User  # 不推荐\n\n# ❌ 不要合并 import\nimport os, sys  # 每个 import 一行\n\n# ❌ 不要 import 具体类/函数（除 typing/collections.abc）\nfrom os.path import join  # 不推荐\nfrom os import path  # 推荐",
    "rationale": "isort 标准顺序，减少合并冲突，提高可读性。Google Style 推荐 import 模块而非具体符号"
  },
  "description": "Python: PEP 8 / isort 标准导入顺序",
  "kind": "rule",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: PEP 8 / isort 标准导入顺序的标准实现模式。",
  "reasoning": {
    "whyStandard": "PEP 8 + Google Python Style Guide §2.2",
    "sources": [
      "PEP 8 - Imports",
      "Google Python Style Guide §2.2"
    ],
    "confidence": 0.95
  }
}
```

### 包结构

```python
# ✅ 推荐的项目结构
myproject/
├── __init__.py          # 包声明
├── __main__.py          # python -m myproject 入口
├── models/
│   ├── __init__.py
│   ├── user.py
│   └── order.py
├── services/
│   ├── __init__.py
│   └── user_service.py
├── api/
│   ├── __init__.py
│   └── routes.py
├── utils/
│   ├── __init__.py
│   └── helpers.py
└── py.typed             # PEP 561: 表示本包提供 inline type stubs

# ✅ __main__.py 入口
def main() -> None:
    ...

if __name__ == '__main__':
    main()
```

---

## 2. 类型提示 (Type Hints)

### 函数签名

```json
{
  "title": "Python: 函数参数和返回值必须标注类型",
  "content": {
    "markdown": "## Python: 函数参数和返回值必须标注类型\n\n### 标准模式\n```python\nfrom collections.abc import Sequence, Mapping\n\n# ✅ 完整的类型标注（Python 3.10+）\ndef find_users(\n    query: str,\n    limit: int = 10,\n    include_inactive: bool = False,\n) -> list[User]:\n    ...\n\n# ✅ Python 3.10+ 使用 X | None 替代 Optional\ndef get_user(user_id: int) -> User | None:\n    ...\n\n# ✅ 参数使用抽象类型（Sequence, Mapping, Iterable）\ndef process_items(items: Sequence[Item]) -> Mapping[str, int]:\n    ...\n\n# ✅ 返回类型使用具体类型\ndef get_names() -> list[str]:\n    return [u.name for u in users]\n\n# ❌ 缺少类型标注\ndef find_users(query, limit=10):\n    ...\n```",
    "pattern": "from collections.abc import Sequence, Mapping\n\n# ✅ 完整的类型标注（Python 3.10+）\ndef find_users(\n    query: str,\n    limit: int = 10,\n    include_inactive: bool = False,\n) -> list[User]:\n    ...\n\n# ✅ Python 3.10+ 使用 X | None 替代 Optional\ndef get_user(user_id: int) -> User | None:\n    ...\n\n# ✅ 参数使用抽象类型（Sequence, Mapping, Iterable）\ndef process_items(items: Sequence[Item]) -> Mapping[str, int]:\n    ...\n\n# ✅ 返回类型使用具体类型\ndef get_names() -> list[str]:\n    return [u.name for u in users]\n\n# ❌ 缺少类型标注\ndef find_users(query, limit=10):\n    ...",
    "rationale": "PEP 484 类型提示提升代码可读性，支持 mypy / pytype 静态检查"
  },
  "description": "Python: 函数参数和返回值必须标注类型",
  "kind": "rule",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: 函数参数和返回值必须标注类型的标准实现模式。",
  "antiPattern": {
    "bad": "def process(data): ...",
    "why": "无法通过静态分析发现类型错误；IDE 无法提供补全和重构支持",
    "fix": "def process(data: bytes) -> str: ..."
  },
  "reasoning": {
    "whyStandard": "Google Python Style Guide §2.21: strongly encouraged",
    "sources": [
      "PEP 484",
      "Google Python Style Guide §2.21"
    ],
    "confidence": 0.95
  }
}
```

### 高级类型模式

```python
from typing import TypeVar, Generic, Protocol, TypeAlias, overload
from collections.abc import Callable

# ✅ TypeVar 用于泛型函数
_T = TypeVar('_T')

def first(items: Sequence[_T]) -> _T | None:
    return items[0] if items else None

# ✅ Protocol 用于结构化子类型（鸭子类型的类型安全版本）
class Renderable(Protocol):
    def render(self) -> str: ...

def display(item: Renderable) -> None:
    print(item.render())

# ✅ TypeAlias 简化复杂类型（Python 3.10+）
_JsonValue: TypeAlias = str | int | float | bool | None | list['_JsonValue'] | dict[str, '_JsonValue']

# ✅ @overload 为多签名函数提供精确类型
@overload
def get(key: str) -> str: ...
@overload
def get(key: str, default: _T) -> str | _T: ...
def get(key, default=...):
    ...
```

---

## 3. 命名约定

### 标准命名

```json
{
  "title": "Python: PEP 8 / Google Style 命名约定",
  "content": {
    "markdown": "## Python: PEP 8 / Google Style 命名约定\n\n### 标准模式\n```python\n# ✅ 模块名: lower_with_under.py\n# user_service.py, http_client.py\n\n# ✅ 类名: CapWords\nclass UserService:\n    pass\n\nclass HTTPClient:  # 缩写全大写\n    pass\n\n# ✅ 异常: CapWords + Error 后缀\nclass NotFoundError(Exception):\n    pass\n\n# ✅ 函数/方法/变量: lower_with_under\ndef get_user_by_id(user_id: int) -> User:\n    pass\n\nmax_retry_count = 3\n\n# ✅ 常量: CAPS_WITH_UNDER\nMAX_CONNECTIONS = 100\nDEFAULT_TIMEOUT_MS = 5000\n\n# ✅ 非公开: 单下划线前缀\ndef _internal_helper():\n    pass\n\nclass _InternalCache:\n    pass\n\n# ✅ TypeVar: CapWords，短名称\n_T = TypeVar('_T')\nAddableType = TypeVar('AddableType', int, float, str)\n```",
    "pattern": "# ✅ 模块名: lower_with_under.py\n# user_service.py, http_client.py\n\n# ✅ 类名: CapWords\nclass UserService:\n    pass\n\nclass HTTPClient:  # 缩写全大写\n    pass\n\n# ✅ 异常: CapWords + Error 后缀\nclass NotFoundError(Exception):\n    pass\n\n# ✅ 函数/方法/变量: lower_with_under\ndef get_user_by_id(user_id: int) -> User:\n    pass\n\nmax_retry_count = 3\n\n# ✅ 常量: CAPS_WITH_UNDER\nMAX_CONNECTIONS = 100\nDEFAULT_TIMEOUT_MS = 5000\n\n# ✅ 非公开: 单下划线前缀\ndef _internal_helper():\n    pass\n\nclass _InternalCache:\n    pass\n\n# ✅ TypeVar: CapWords，短名称\n_T = TypeVar('_T')\nAddableType = TypeVar('AddableType', int, float, str)",
    "rationale": "统一的命名约定让代码可预测，降低认知负担"
  },
  "description": "Python: PEP 8 / Google Style 命名约定",
  "kind": "rule",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: PEP 8 / Google Style 命名约定的标准实现模式。",
  "reasoning": {
    "whyStandard": "PEP 8 §3.16 + Google Python Style Guide §3.16.4",
    "sources": [
      "PEP 8 - Naming Conventions",
      "Google Python Style Guide §3.16"
    ],
    "confidence": 0.95
  }
}
```

### 命名速查表

| 标识符类型 | 风格 | 示例 |
|-----------|------|------|
| 模块文件 | `lower_with_under.py` | `user_service.py` |
| 包 | `lower_with_under` | `myproject` |
| 类 | `CapWords` | `UserService`, `HTTPClient` |
| 异常 | `CapWords` + `Error` | `NotFoundError` |
| 函数/方法 | `lower_with_under` | `get_user_by_id()` |
| 变量/参数 | `lower_with_under` | `max_count`, `user_id` |
| 常量 | `CAPS_WITH_UNDER` | `MAX_RETRIES` |
| 非公开 | `_leading_underscore` | `_helper()`, `_cache` |
| 名称修饰 | `__double_leading` | `__secret`（不推荐） |
| TypeVar | `_T` 或 `CapWordsType` | `_T`, `AddableType` |

### 命名反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `userList` (camelCase) | 非 Python 风格 | `user_list` |
| `class user_service:` | 类应 CapWords | `class UserService:` |
| `__private_var` | 双下划线触发名称修饰，仅在避免子类冲突时用 | `_private_var` |
| `from foo import *` | 污染命名空间，隐式依赖 | 显式导入 |
| `l = []`, `O = 0` | 与 1/0 易混淆 | 有意义名称 |

---

## 4. 错误处理

### 异常层级

```json
{
  "title": "Python: 自定义异常体系 + 精确捕获",
  "content": {
    "markdown": "## Python: 自定义异常体系 + 精确捕获\n\n### 标准模式\n```python\n# ✅ 项目级异常基类\nclass AppError(Exception):\n    \"\"\"项目所有自定义异常的基类。\"\"\"\n    def __init__(self, message: str, code: str | None = None) -> None:\n        super().__init__(message)\n        self.code = code\n\nclass NotFoundError(AppError):\n    \"\"\"资源不存在。\"\"\"\n\nclass ValidationError(AppError):\n    \"\"\"输入校验失败。\"\"\"\n\n# ✅ 精确捕获 + 异常链\ntry:\n    user = await user_repo.get(user_id)\nexcept NotFoundError:\n    raise HTTPException(status_code=404, detail='User not found')\nexcept DatabaseError as e:\n    # 异常链: 保留原始 traceback\n    raise ServiceError('DB failure') from e\n\n# ✅ 最小化 try 块\ntry:\n    value = collection[key]  # 只包含可能抛异常的行\nexcept KeyError:\n    return default\nelse:\n    return transform(value)  # 成功时的逻辑放 else\nfinally:\n    cleanup()  # 清理放 finally\n```",
    "pattern": "# ✅ 项目级异常基类\nclass AppError(Exception):\n    \"\"\"项目所有自定义异常的基类。\"\"\"\n    def __init__(self, message: str, code: str | None = None) -> None:\n        super().__init__(message)\n        self.code = code\n\nclass NotFoundError(AppError):\n    \"\"\"资源不存在。\"\"\"\n\nclass ValidationError(AppError):\n    \"\"\"输入校验失败。\"\"\"\n\n# ✅ 精确捕获 + 异常链\ntry:\n    user = await user_repo.get(user_id)\nexcept NotFoundError:\n    raise HTTPException(status_code=404, detail='User not found')\nexcept DatabaseError as e:\n    # 异常链: 保留原始 traceback\n    raise ServiceError('DB failure') from e\n\n# ✅ 最小化 try 块\ntry:\n    value = collection[key]  # 只包含可能抛异常的行\nexcept KeyError:\n    return default\nelse:\n    return transform(value)  # 成功时的逻辑放 else\nfinally:\n    cleanup()  # 清理放 finally",
    "rationale": "Python: 自定义异常体系 + 精确捕获的标准实现模式。"
  },
  "description": "Python: 自定义异常体系 + 精确捕获",
  "kind": "pattern",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: 自定义异常体系 + 精确捕获的标准实现模式。",
  "antiPattern": {
    "bad": "try:\n    ...\nexcept:\n    pass",
    "why": "bare except 捕获所有异常包括 KeyboardInterrupt / SystemExit；空 catch 吞掉错误",
    "fix": "except SpecificError as e: handle(e)"
  },
  "reasoning": {
    "whyStandard": "Google Python Style Guide §2.4; PEP 8 Programming Recommendations",
    "sources": [
      "Google Python Style Guide §2.4",
      "PEP 8 - Programming Recommendations"
    ],
    "confidence": 0.95
  }
}
```

### 异常处理反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `except:` (bare except) | 捕获 SystemExit, KeyboardInterrupt | `except Exception:` |
| `except Exception: pass` | 吞掉所有错误 | 至少 log 或 reraise |
| `assert x > 0` (校验用) | `-O` 模式下 assert 被移除 | `if x <= 0: raise ValueError(...)` |
| 过宽 try 块 | 掩盖非预期异常 | 最小化 try 体 |
| `raise Exception('...')` | 无法精确捕获 | 自定义异常子类 |

---

## 5. 上下文管理 (Context Manager)

```json
{
  "title": "Python: with 语句管理资源生命周期",
  "content": {
    "markdown": "## Python: with 语句管理资源生命周期\n\n### 标准模式\n```python\nimport contextlib\nfrom contextlib import asynccontextmanager\n\n# ✅ 文件操作必须使用 with\nwith open('data.json') as f:\n    data = json.load(f)\n\n# ✅ 多个上下文管理器（Python 3.10+）\nwith (\n    open('input.txt') as src,\n    open('output.txt', 'w') as dst,\n):\n    dst.write(src.read())\n\n# ✅ 自定义上下文管理器（生成器方式）\n@contextlib.contextmanager\ndef timer(label: str):\n    t0 = time.perf_counter()\n    try:\n        yield\n    finally:\n        elapsed = time.perf_counter() - t0\n        logger.info(f'{label}: {elapsed:.3f}s')\n\nwith timer('query'):\n    results = db.execute(query)\n\n# ✅ 异步上下文管理器\n@asynccontextmanager\nasync def get_db_session():\n    session = await create_session()\n    try:\n        yield session\n        await session.commit()\n    except Exception:\n        await session.rollback()\n        raise\n    finally:\n        await session.close()\n\n# ❌ 不使用 with 的资源管理\nf = open('data.json')  # 忘记 close → 资源泄露\ndata = json.load(f)\nf.close()\n```",
    "pattern": "import contextlib\nfrom contextlib import asynccontextmanager\n\n# ✅ 文件操作必须使用 with\nwith open('data.json') as f:\n    data = json.load(f)\n\n# ✅ 多个上下文管理器（Python 3.10+）\nwith (\n    open('input.txt') as src,\n    open('output.txt', 'w') as dst,\n):\n    dst.write(src.read())\n\n# ✅ 自定义上下文管理器（生成器方式）\n@contextlib.contextmanager\ndef timer(label: str):\n    t0 = time.perf_counter()\n    try:\n        yield\n    finally:\n        elapsed = time.perf_counter() - t0\n        logger.info(f'{label}: {elapsed:.3f}s')\n\nwith timer('query'):\n    results = db.execute(query)\n\n# ✅ 异步上下文管理器\n@asynccontextmanager\nasync def get_db_session():\n    session = await create_session()\n    try:\n        yield session\n        await session.commit()\n    except Exception:\n        await session.rollback()\n        raise\n    finally:\n        await session.close()\n\n# ❌ 不使用 with 的资源管理\nf = open('data.json')  # 忘记 close → 资源泄露\ndata = json.load(f)\nf.close()",
    "rationale": "with 语句确保资源在异常时也能正确释放，避免 fd 泄露"
  },
  "description": "Python: with 语句管理资源生命周期",
  "kind": "pattern",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: with 语句管理资源生命周期的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Python Style Guide §3.11: 'explicitly close files and sockets when done'",
    "sources": [
      "PEP 343",
      "Google Python Style Guide §3.11"
    ],
    "confidence": 0.95
  }
}
```

---

## 6. 推导式与生成器

```json
{
  "title": "Python: 推导式使用规范",
  "content": {
    "markdown": "## Python: 推导式使用规范\n\n### 标准模式\n```python\n# ✅ 简洁的列表推导\nresult = [transform(x) for x in iterable if is_valid(x)]\n\n# ✅ 字典推导\nname_to_user = {u.name: u for u in users}\n\n# ✅ 集合推导\nunique_tags = {tag for item in items for tag in item.tags}\n\n# ✅ 生成器表达式 — 惰性求值，节省内存\ntotal = sum(order.amount for order in orders if order.is_paid)\n\n# ✅ 复杂逻辑用传统循环 + append\nresult = []\nfor x in range(10):\n    for y in range(5):\n        if x * y > 10:\n            result.append((x, y))\n\n# ❌ 多层 for + if 推导（可读性差）\nresult = [(x, y) for x in range(10) for y in range(5) if x * y > 10]\n\n# ❌ 有副作用的推导\n[print(x) for x in items]  # 用 for 循环\n```",
    "pattern": "# ✅ 简洁的列表推导\nresult = [transform(x) for x in iterable if is_valid(x)]\n\n# ✅ 字典推导\nname_to_user = {u.name: u for u in users}\n\n# ✅ 集合推导\nunique_tags = {tag for item in items for tag in item.tags}\n\n# ✅ 生成器表达式 — 惰性求值，节省内存\ntotal = sum(order.amount for order in orders if order.is_paid)\n\n# ✅ 复杂逻辑用传统循环 + append\nresult = []\nfor x in range(10):\n    for y in range(5):\n        if x * y > 10:\n            result.append((x, y))\n\n# ❌ 多层 for + if 推导（可读性差）\nresult = [(x, y) for x in range(10) for y in range(5) if x * y > 10]\n\n# ❌ 有副作用的推导\n[print(x) for x in items]  # 用 for 循环",
    "rationale": "Google Style: 推导只用于简单场景，多个 for 或 filter 不允许"
  },
  "description": "Python: 推导式使用规范",
  "kind": "pattern",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: 推导式使用规范的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Python Style Guide §2.7: 'multiple for clauses or filter expressions are not permitted'",
    "sources": [
      "Google Python Style Guide §2.7"
    ],
    "confidence": 0.9
  }
}
```

---

## 7. 异步编程

### async/await 模式

```json
{
  "title": "Python: 正确使用 async/await",
  "content": {
    "markdown": "## Python: 正确使用 async/await\n\n### 标准模式\n```python\nimport asyncio\nfrom collections.abc import AsyncIterator\n\n# ✅ async 函数 + 资源管理\nasync def fetch_user(user_id: int) -> User:\n    async with httpx.AsyncClient() as client:\n        resp = await client.get(f'/users/{user_id}')\n        resp.raise_for_status()\n        return User(**resp.json())\n\n# ✅ 并发执行多个异步任务\nasync def fetch_dashboard(user_id: int) -> Dashboard:\n    async with asyncio.TaskGroup() as tg:\n        user_task = tg.create_task(fetch_user(user_id))\n        orders_task = tg.create_task(fetch_orders(user_id))\n        notifs_task = tg.create_task(fetch_notifications(user_id))\n    return Dashboard(\n        user=user_task.result(),\n        orders=orders_task.result(),\n        notifications=notifs_task.result(),\n    )\n\n# ✅ async generator (流式处理)\nasync def stream_events(source: str) -> AsyncIterator[Event]:\n    async with connect(source) as ws:\n        async for message in ws:\n            yield Event.parse(message)\n\n# ✅ 超时控制\nasync def fetch_with_timeout(url: str) -> bytes:\n    async with asyncio.timeout(10):\n        return await fetch(url)\n```",
    "pattern": "import asyncio\nfrom collections.abc import AsyncIterator\n\n# ✅ async 函数 + 资源管理\nasync def fetch_user(user_id: int) -> User:\n    async with httpx.AsyncClient() as client:\n        resp = await client.get(f'/users/{user_id}')\n        resp.raise_for_status()\n        return User(**resp.json())\n\n# ✅ 并发执行多个异步任务\nasync def fetch_dashboard(user_id: int) -> Dashboard:\n    async with asyncio.TaskGroup() as tg:\n        user_task = tg.create_task(fetch_user(user_id))\n        orders_task = tg.create_task(fetch_orders(user_id))\n        notifs_task = tg.create_task(fetch_notifications(user_id))\n    return Dashboard(\n        user=user_task.result(),\n        orders=orders_task.result(),\n        notifications=notifs_task.result(),\n    )\n\n# ✅ async generator (流式处理)\nasync def stream_events(source: str) -> AsyncIterator[Event]:\n    async with connect(source) as ws:\n        async for message in ws:\n            yield Event.parse(message)\n\n# ✅ 超时控制\nasync def fetch_with_timeout(url: str) -> bytes:\n    async with asyncio.timeout(10):\n        return await fetch(url)",
    "rationale": "Python: 正确使用 async/await的标准实现模式。"
  },
  "description": "Python: 正确使用 async/await",
  "kind": "pattern",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: 正确使用 async/await的标准实现模式。",
  "reasoning": {
    "whyStandard": "Python 3.11+ TaskGroup, 3.12+ asyncio.timeout 是官方推荐的结构化并发原语",
    "sources": [
      "Python asyncio docs",
      "PEP 654 (ExceptionGroup)"
    ],
    "confidence": 0.9
  }
}
```

### async 反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `asyncio.gather(*tasks)` 无错误处理 | 一个失败全部取消 | `TaskGroup` 或 `return_exceptions=True` |
| 串行 `await a(); await b()` | 独立任务被串行化 | `TaskGroup` 并发 |
| `loop.run_until_complete()` | 手动事件循环管理 | `asyncio.run()` |
| 在 async 中调用阻塞 IO | 阻塞整个事件循环 | `await asyncio.to_thread(blocking_fn)` |

---

## 8. Decorator 模式

```json
{
  "title": "Python: Decorator 最佳实践",
  "content": {
    "markdown": "## Python: Decorator 最佳实践\n\n### 标准模式\n```python\nimport functools\nfrom typing import TypeVar, ParamSpec\nfrom collections.abc import Callable\n\n_P = ParamSpec('_P')\n_T = TypeVar('_T')\n\n# ✅ 使用 functools.wraps 保留原函数元信息\ndef retry(max_attempts: int = 3, delay: float = 1.0):\n    \"\"\"Decorator: 失败重试。\"\"\"\n    def decorator(func: Callable[_P, _T]) -> Callable[_P, _T]:\n        @functools.wraps(func)\n        def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> _T:\n            last_exc: Exception | None = None\n            for attempt in range(max_attempts):\n                try:\n                    return func(*args, **kwargs)\n                except Exception as e:\n                    last_exc = e\n                    time.sleep(delay * (2 ** attempt))\n            raise last_exc  # type: ignore[misc]\n        return wrapper\n    return decorator\n\n@retry(max_attempts=3, delay=0.5)\ndef fetch_data(url: str) -> dict:\n    ...\n\n# ✅ 类级 decorator 替代继承\n@dataclass(frozen=True, slots=True)\nclass Point:\n    x: float\n    y: float\n```",
    "pattern": "import functools\nfrom typing import TypeVar, ParamSpec\nfrom collections.abc import Callable\n\n_P = ParamSpec('_P')\n_T = TypeVar('_T')\n\n# ✅ 使用 functools.wraps 保留原函数元信息\ndef retry(max_attempts: int = 3, delay: float = 1.0):\n    \"\"\"Decorator: 失败重试。\"\"\"\n    def decorator(func: Callable[_P, _T]) -> Callable[_P, _T]:\n        @functools.wraps(func)\n        def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> _T:\n            last_exc: Exception | None = None\n            for attempt in range(max_attempts):\n                try:\n                    return func(*args, **kwargs)\n                except Exception as e:\n                    last_exc = e\n                    time.sleep(delay * (2 ** attempt))\n            raise last_exc  # type: ignore[misc]\n        return wrapper\n    return decorator\n\n@retry(max_attempts=3, delay=0.5)\ndef fetch_data(url: str) -> dict:\n    ...\n\n# ✅ 类级 decorator 替代继承\n@dataclass(frozen=True, slots=True)\nclass Point:\n    x: float\n    y: float",
    "rationale": "Python: Decorator 最佳实践的标准实现模式。"
  },
  "description": "Python: Decorator 最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: Decorator 最佳实践的标准实现模式。",
  "antiPattern": {
    "bad": "def my_decorator(func):\n    def wrapper(*args, **kwargs): return func(*args, **kwargs)\n    return wrapper",
    "why": "未使用 @functools.wraps，丢失 __name__, __doc__, __module__",
    "fix": "添加 @functools.wraps(func)"
  },
  "reasoning": {
    "whyStandard": "Google Python Style Guide §2.17: 'use decorators judiciously, avoid staticmethod'",
    "sources": [
      "Google Python Style Guide §2.17"
    ],
    "confidence": 0.9
  }
}
```

---

## 9. 数据类

```json
{
  "title": "Python: dataclass vs Pydantic vs NamedTuple",
  "content": {
    "markdown": "## Python: dataclass vs Pydantic vs NamedTuple\n\n### 标准模式\n```python\nfrom dataclasses import dataclass, field\nfrom typing import NamedTuple\nfrom pydantic import BaseModel, Field\n\n# ✅ dataclass: 内部可变数据结构\n@dataclass\nclass UserProfile:\n    name: str\n    age: int\n    email: str = ''\n    tags: list[str] = field(default_factory=list)\n\n# ✅ frozen dataclass: 不可变值对象\n@dataclass(frozen=True, slots=True)\nclass Coordinate:\n    lat: float\n    lon: float\n\n# ✅ NamedTuple: 轻量不可变记录\nclass Version(NamedTuple):\n    major: int\n    minor: int\n    patch: int\n\n# ✅ Pydantic BaseModel: 外部输入校验\nclass CreateUserRequest(BaseModel):\n    name: str = Field(..., min_length=1, max_length=100)\n    age: int = Field(..., ge=0, le=200)\n    email: str = Field(..., pattern=r'^[^@]+@[^@]+\\.[^@]+

---

## 10. Docstring 规范

```json
{
  "title": "Python: Google Style Docstring",
  "content": {
    "markdown": "## Python: Google Style Docstring\n\n### 标准模式\n```python\ndef fetch_rows(\n    table: str,\n    keys: Sequence[str],\n    require_all: bool = False,\n) -> Mapping[str, tuple[str, ...]]:\n    \"\"\"从数据表获取指定行。\n\n    根据给定的 keys 从 table 中检索对应行数据。\n    字符串类型的 key 会被 UTF-8 编码。\n\n    Args:\n        table: 目标数据表名称。\n        keys: 要检索的行 key 列表。\n        require_all: 若为 True，仅在所有 key\n            都存在时返回结果。\n\n    Returns:\n        key → 行数据的映射。每行表示为字符串元组。\n        例如::\n\n            {'row1': ('col_a', 'col_b'),\n             'row2': ('col_a', 'col_b')}\n\n    Raises:\n        IOError: 访问数据表时发生 I/O 错误。\n        KeyError: require_all=True 且某 key 不存在。\n    \"\"\"\n\nclass CheeseShop:\n    \"\"\"奶酪商店的地址信息。\n\n    Attributes:\n        name: 商店名称。\n        address: 完整地址。\n        inventory: 库存奶酪种类数。\n    \"\"\"\n\n    def __init__(self, name: str, address: str) -> None:\n        self.name = name\n        self.address = address\n        self.inventory: int = 0\n```",
    "pattern": "def fetch_rows(\n    table: str,\n    keys: Sequence[str],\n    require_all: bool = False,\n) -> Mapping[str, tuple[str, ...]]:\n    \"\"\"从数据表获取指定行。\n\n    根据给定的 keys 从 table 中检索对应行数据。\n    字符串类型的 key 会被 UTF-8 编码。\n\n    Args:\n        table: 目标数据表名称。\n        keys: 要检索的行 key 列表。\n        require_all: 若为 True，仅在所有 key\n            都存在时返回结果。\n\n    Returns:\n        key → 行数据的映射。每行表示为字符串元组。\n        例如::\n\n            {'row1': ('col_a', 'col_b'),\n             'row2': ('col_a', 'col_b')}\n\n    Raises:\n        IOError: 访问数据表时发生 I/O 错误。\n        KeyError: require_all=True 且某 key 不存在。\n    \"\"\"\n\nclass CheeseShop:\n    \"\"\"奶酪商店的地址信息。\n\n    Attributes:\n        name: 商店名称。\n        address: 完整地址。\n        inventory: 库存奶酪种类数。\n    \"\"\"\n\n    def __init__(self, name: str, address: str) -> None:\n        self.name = name\n        self.address = address\n        self.inventory: int = 0",
    "rationale": "Google Style docstring 结构清晰，支持 Sphinx / pydoc 自动生成文档"
  },
  "description": "Python: Google Style Docstring",
  "kind": "rule",
  "doClause": "Follow Style Docstring conventions",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: Google Style Docstring的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Python Style Guide §3.8; PEP 257",
    "sources": [
      "Google Python Style Guide §3.8",
      "PEP 257"
    ],
    "confidence": 0.95
  }
}
```

---

## 11. 真值判断与比较

```python
# ✅ 使用隐式布尔 — PEP 8 推荐
if not users:          # 空列表
    print('no users')

if name:               # 非空字符串
    greet(name)

# ✅ None 比较用 is / is not
if value is None:
    value = default

if result is not None:
    process(result)

# ✅ 整数比较用显式 ==
if count == 0:         # 不要 `if not count:`（None 也为 False）
    reset()

# ❌ 反模式
if len(users) == 0:    # 冗余 → if not users:
if greeting == True:   # 冗余 → if greeting:
if greeting is True:   # 更糟
if not x is None:      # 可读性差 → if x is not None:
```

---

## 12. 可变默认参数陷阱

```json
{
  "title": "Python: 不要使用可变对象作为默认参数",
  "content": {
    "markdown": "## Python: 不要使用可变对象作为默认参数\n\n### 标准模式\n```python\n# ✅ 正确: None 哨兵 + 函数内创建\ndef append_to(item: int, target: list[int] | None = None) -> list[int]:\n    if target is None:\n        target = []\n    target.append(item)\n    return target\n\n# ✅ 正确: 不可变默认值\ndef process(items: Sequence[str] = ()) -> None:\n    ...\n\n# ❌ 危险: 可变默认参数在模块加载时创建一次，所有调用共享同一个对象\ndef append_to(item: int, target: list[int] = []) -> list[int]:\n    target.append(item)\n    return target\n\n# append_to(1) → [1]\n# append_to(2) → [1, 2]  ← 累积了!\n```",
    "pattern": "# ✅ 正确: None 哨兵 + 函数内创建\ndef append_to(item: int, target: list[int] | None = None) -> list[int]:\n    if target is None:\n        target = []\n    target.append(item)\n    return target\n\n# ✅ 正确: 不可变默认值\ndef process(items: Sequence[str] = ()) -> None:\n    ...\n\n# ❌ 危险: 可变默认参数在模块加载时创建一次，所有调用共享同一个对象\ndef append_to(item: int, target: list[int] = []) -> list[int]:\n    target.append(item)\n    return target\n\n# append_to(1) → [1]\n# append_to(2) → [1, 2]  ← 累积了!",
    "rationale": "Python 默认值在函数定义时求值一次，可变对象被所有调用共享"
  },
  "description": "Python: 不要使用可变对象作为默认参数",
  "kind": "pattern",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: 不要使用可变对象作为默认参数的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Python Style Guide §2.12; 最常见的 Python 陷阱之一",
    "sources": [
      "Google Python Style Guide §2.12",
      "PEP 8"
    ],
    "confidence": 0.95
  }
}
```

---

## 13. Python 特有维度 (extraDimensions)

冷启动分析 Python 项目时，除了通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **类型安全** | type hints 覆盖率、mypy strict、Protocol 使用 | `code-standard` |
| **包管理** | pyproject.toml vs setup.py、依赖分组、lock 文件 | `config` |
| **异步模式** | asyncio / TaskGroup / async generator | `code-pattern` |
| **数据校验** | Pydantic model、dataclass、NamedTuple 选择 | `code-pattern` |
| **上下文管理** | with 语句覆盖率、自定义 context manager | `best-practice` |
| **框架模式** | Django ORM/Views、FastAPI routes、Flask blueprints | `code-pattern` |
| **测试模式** | pytest fixtures、parametrize、mock patch | `best-practice` |
| **文档** | docstring 覆盖率、Google/NumPy style | `code-standard` |

---

## 关联 Skills

- **autosnippet-coldstart**: 冷启动分析模板
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-java**: Java 业界最佳实践参考
- **autosnippet-reference-kotlin**: Kotlin 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
)\n\n    model_config = {'str_strip_whitespace': True}\n\n# 选择指南:\n# 内部数据 + 可变 → dataclass\n# 内部数据 + 不可变 → frozen dataclass 或 NamedTuple\n# 外部输入(API/文件) → Pydantic BaseModel (自带校验 + 序列化)\n```",
    "pattern": "from dataclasses import dataclass, field\nfrom typing import NamedTuple\nfrom pydantic import BaseModel, Field\n\n# ✅ dataclass: 内部可变数据结构\n@dataclass\nclass UserProfile:\n    name: str\n    age: int\n    email: str = ''\n    tags: list[str] = field(default_factory=list)\n\n# ✅ frozen dataclass: 不可变值对象\n@dataclass(frozen=True, slots=True)\nclass Coordinate:\n    lat: float\n    lon: float\n\n# ✅ NamedTuple: 轻量不可变记录\nclass Version(NamedTuple):\n    major: int\n    minor: int\n    patch: int\n\n# ✅ Pydantic BaseModel: 外部输入校验\nclass CreateUserRequest(BaseModel):\n    name: str = Field(..., min_length=1, max_length=100)\n    age: int = Field(..., ge=0, le=200)\n    email: str = Field(..., pattern=r'^[^@]+@[^@]+\\.[^@]+

---

## 10. Docstring 规范

```json
{
  "title": "Python: Google Style Docstring",
  "content": {
    "markdown": "## Python: Google Style Docstring\n\n### 标准模式\n```python\ndef fetch_rows(\n    table: str,\n    keys: Sequence[str],\n    require_all: bool = False,\n) -> Mapping[str, tuple[str, ...]]:\n    \"\"\"从数据表获取指定行。\n\n    根据给定的 keys 从 table 中检索对应行数据。\n    字符串类型的 key 会被 UTF-8 编码。\n\n    Args:\n        table: 目标数据表名称。\n        keys: 要检索的行 key 列表。\n        require_all: 若为 True，仅在所有 key\n            都存在时返回结果。\n\n    Returns:\n        key → 行数据的映射。每行表示为字符串元组。\n        例如::\n\n            {'row1': ('col_a', 'col_b'),\n             'row2': ('col_a', 'col_b')}\n\n    Raises:\n        IOError: 访问数据表时发生 I/O 错误。\n        KeyError: require_all=True 且某 key 不存在。\n    \"\"\"\n\nclass CheeseShop:\n    \"\"\"奶酪商店的地址信息。\n\n    Attributes:\n        name: 商店名称。\n        address: 完整地址。\n        inventory: 库存奶酪种类数。\n    \"\"\"\n\n    def __init__(self, name: str, address: str) -> None:\n        self.name = name\n        self.address = address\n        self.inventory: int = 0\n```",
    "pattern": "def fetch_rows(\n    table: str,\n    keys: Sequence[str],\n    require_all: bool = False,\n) -> Mapping[str, tuple[str, ...]]:\n    \"\"\"从数据表获取指定行。\n\n    根据给定的 keys 从 table 中检索对应行数据。\n    字符串类型的 key 会被 UTF-8 编码。\n\n    Args:\n        table: 目标数据表名称。\n        keys: 要检索的行 key 列表。\n        require_all: 若为 True，仅在所有 key\n            都存在时返回结果。\n\n    Returns:\n        key → 行数据的映射。每行表示为字符串元组。\n        例如::\n\n            {'row1': ('col_a', 'col_b'),\n             'row2': ('col_a', 'col_b')}\n\n    Raises:\n        IOError: 访问数据表时发生 I/O 错误。\n        KeyError: require_all=True 且某 key 不存在。\n    \"\"\"\n\nclass CheeseShop:\n    \"\"\"奶酪商店的地址信息。\n\n    Attributes:\n        name: 商店名称。\n        address: 完整地址。\n        inventory: 库存奶酪种类数。\n    \"\"\"\n\n    def __init__(self, name: str, address: str) -> None:\n        self.name = name\n        self.address = address\n        self.inventory: int = 0",
    "rationale": "Google Style docstring 结构清晰，支持 Sphinx / pydoc 自动生成文档"
  },
  "description": "Python: Google Style Docstring",
  "kind": "rule",
  "doClause": "Follow Style Docstring conventions",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: Google Style Docstring的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Python Style Guide §3.8; PEP 257",
    "sources": [
      "Google Python Style Guide §3.8",
      "PEP 257"
    ],
    "confidence": 0.95
  }
}
```

---

## 11. 真值判断与比较

```python
# ✅ 使用隐式布尔 — PEP 8 推荐
if not users:          # 空列表
    print('no users')

if name:               # 非空字符串
    greet(name)

# ✅ None 比较用 is / is not
if value is None:
    value = default

if result is not None:
    process(result)

# ✅ 整数比较用显式 ==
if count == 0:         # 不要 `if not count:`（None 也为 False）
    reset()

# ❌ 反模式
if len(users) == 0:    # 冗余 → if not users:
if greeting == True:   # 冗余 → if greeting:
if greeting is True:   # 更糟
if not x is None:      # 可读性差 → if x is not None:
```

---

## 12. 可变默认参数陷阱

```json
{
  "title": "Python: 不要使用可变对象作为默认参数",
  "content": {
    "markdown": "## Python: 不要使用可变对象作为默认参数\n\n### 标准模式\n```python\n# ✅ 正确: None 哨兵 + 函数内创建\ndef append_to(item: int, target: list[int] | None = None) -> list[int]:\n    if target is None:\n        target = []\n    target.append(item)\n    return target\n\n# ✅ 正确: 不可变默认值\ndef process(items: Sequence[str] = ()) -> None:\n    ...\n\n# ❌ 危险: 可变默认参数在模块加载时创建一次，所有调用共享同一个对象\ndef append_to(item: int, target: list[int] = []) -> list[int]:\n    target.append(item)\n    return target\n\n# append_to(1) → [1]\n# append_to(2) → [1, 2]  ← 累积了!\n```",
    "pattern": "# ✅ 正确: None 哨兵 + 函数内创建\ndef append_to(item: int, target: list[int] | None = None) -> list[int]:\n    if target is None:\n        target = []\n    target.append(item)\n    return target\n\n# ✅ 正确: 不可变默认值\ndef process(items: Sequence[str] = ()) -> None:\n    ...\n\n# ❌ 危险: 可变默认参数在模块加载时创建一次，所有调用共享同一个对象\ndef append_to(item: int, target: list[int] = []) -> list[int]:\n    target.append(item)\n    return target\n\n# append_to(1) → [1]\n# append_to(2) → [1, 2]  ← 累积了!",
    "rationale": "Python 默认值在函数定义时求值一次，可变对象被所有调用共享"
  },
  "description": "Python: 不要使用可变对象作为默认参数",
  "kind": "pattern",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: 不要使用可变对象作为默认参数的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Python Style Guide §2.12; 最常见的 Python 陷阱之一",
    "sources": [
      "Google Python Style Guide §2.12",
      "PEP 8"
    ],
    "confidence": 0.95
  }
}
```

---

## 13. Python 特有维度 (extraDimensions)

冷启动分析 Python 项目时，除了通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **类型安全** | type hints 覆盖率、mypy strict、Protocol 使用 | `code-standard` |
| **包管理** | pyproject.toml vs setup.py、依赖分组、lock 文件 | `config` |
| **异步模式** | asyncio / TaskGroup / async generator | `code-pattern` |
| **数据校验** | Pydantic model、dataclass、NamedTuple 选择 | `code-pattern` |
| **上下文管理** | with 语句覆盖率、自定义 context manager | `best-practice` |
| **框架模式** | Django ORM/Views、FastAPI routes、Flask blueprints | `code-pattern` |
| **测试模式** | pytest fixtures、parametrize、mock patch | `best-practice` |
| **文档** | docstring 覆盖率、Google/NumPy style | `code-standard` |

---

## 关联 Skills

- **autosnippet-coldstart**: 冷启动分析模板
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-java**: Java 业界最佳实践参考
- **autosnippet-reference-kotlin**: Kotlin 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
)\n\n    model_config = {'str_strip_whitespace': True}\n\n# 选择指南:\n# 内部数据 + 可变 → dataclass\n# 内部数据 + 不可变 → frozen dataclass 或 NamedTuple\n# 外部输入(API/文件) → Pydantic BaseModel (自带校验 + 序列化)",
    "rationale": "dataclass 减少样板代码，Pydantic 提供运行时校验，各有适用场景"
  },
  "description": "Python: dataclass vs Pydantic vs NamedTuple",
  "kind": "pattern",
  "doClause": "Follow vs Pydantic vs NamedTuple conventions",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: dataclass vs Pydantic vs NamedTuple的标准实现模式。",
  "reasoning": {
    "whyStandard": "PEP 557 (dataclasses), Pydantic 是 FastAPI 生态标配",
    "sources": [
      "PEP 557",
      "Pydantic docs"
    ],
    "confidence": 0.9
  }
}
```

---

## 10. Docstring 规范

```json
{
  "title": "Python: Google Style Docstring",
  "content": {
    "markdown": "## Python: Google Style Docstring\n\n### 标准模式\n```python\ndef fetch_rows(\n    table: str,\n    keys: Sequence[str],\n    require_all: bool = False,\n) -> Mapping[str, tuple[str, ...]]:\n    \"\"\"从数据表获取指定行。\n\n    根据给定的 keys 从 table 中检索对应行数据。\n    字符串类型的 key 会被 UTF-8 编码。\n\n    Args:\n        table: 目标数据表名称。\n        keys: 要检索的行 key 列表。\n        require_all: 若为 True，仅在所有 key\n            都存在时返回结果。\n\n    Returns:\n        key → 行数据的映射。每行表示为字符串元组。\n        例如::\n\n            {'row1': ('col_a', 'col_b'),\n             'row2': ('col_a', 'col_b')}\n\n    Raises:\n        IOError: 访问数据表时发生 I/O 错误。\n        KeyError: require_all=True 且某 key 不存在。\n    \"\"\"\n\nclass CheeseShop:\n    \"\"\"奶酪商店的地址信息。\n\n    Attributes:\n        name: 商店名称。\n        address: 完整地址。\n        inventory: 库存奶酪种类数。\n    \"\"\"\n\n    def __init__(self, name: str, address: str) -> None:\n        self.name = name\n        self.address = address\n        self.inventory: int = 0\n```",
    "pattern": "def fetch_rows(\n    table: str,\n    keys: Sequence[str],\n    require_all: bool = False,\n) -> Mapping[str, tuple[str, ...]]:\n    \"\"\"从数据表获取指定行。\n\n    根据给定的 keys 从 table 中检索对应行数据。\n    字符串类型的 key 会被 UTF-8 编码。\n\n    Args:\n        table: 目标数据表名称。\n        keys: 要检索的行 key 列表。\n        require_all: 若为 True，仅在所有 key\n            都存在时返回结果。\n\n    Returns:\n        key → 行数据的映射。每行表示为字符串元组。\n        例如::\n\n            {'row1': ('col_a', 'col_b'),\n             'row2': ('col_a', 'col_b')}\n\n    Raises:\n        IOError: 访问数据表时发生 I/O 错误。\n        KeyError: require_all=True 且某 key 不存在。\n    \"\"\"\n\nclass CheeseShop:\n    \"\"\"奶酪商店的地址信息。\n\n    Attributes:\n        name: 商店名称。\n        address: 完整地址。\n        inventory: 库存奶酪种类数。\n    \"\"\"\n\n    def __init__(self, name: str, address: str) -> None:\n        self.name = name\n        self.address = address\n        self.inventory: int = 0",
    "rationale": "Google Style docstring 结构清晰，支持 Sphinx / pydoc 自动生成文档"
  },
  "description": "Python: Google Style Docstring",
  "kind": "rule",
  "doClause": "Follow Style Docstring conventions",
  "language": "python",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: Google Style Docstring的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Python Style Guide §3.8; PEP 257",
    "sources": [
      "Google Python Style Guide §3.8",
      "PEP 257"
    ],
    "confidence": 0.95
  }
}
```

---

## 11. 真值判断与比较

```python
# ✅ 使用隐式布尔 — PEP 8 推荐
if not users:          # 空列表
    print('no users')

if name:               # 非空字符串
    greet(name)

# ✅ None 比较用 is / is not
if value is None:
    value = default

if result is not None:
    process(result)

# ✅ 整数比较用显式 ==
if count == 0:         # 不要 `if not count:`（None 也为 False）
    reset()

# ❌ 反模式
if len(users) == 0:    # 冗余 → if not users:
if greeting == True:   # 冗余 → if greeting:
if greeting is True:   # 更糟
if not x is None:      # 可读性差 → if x is not None:
```

---

## 12. 可变默认参数陷阱

```json
{
  "title": "Python: 不要使用可变对象作为默认参数",
  "content": {
    "markdown": "## Python: 不要使用可变对象作为默认参数\n\n### 标准模式\n```python\n# ✅ 正确: None 哨兵 + 函数内创建\ndef append_to(item: int, target: list[int] | None = None) -> list[int]:\n    if target is None:\n        target = []\n    target.append(item)\n    return target\n\n# ✅ 正确: 不可变默认值\ndef process(items: Sequence[str] = ()) -> None:\n    ...\n\n# ❌ 危险: 可变默认参数在模块加载时创建一次，所有调用共享同一个对象\ndef append_to(item: int, target: list[int] = []) -> list[int]:\n    target.append(item)\n    return target\n\n# append_to(1) → [1]\n# append_to(2) → [1, 2]  ← 累积了!\n```",
    "pattern": "# ✅ 正确: None 哨兵 + 函数内创建\ndef append_to(item: int, target: list[int] | None = None) -> list[int]:\n    if target is None:\n        target = []\n    target.append(item)\n    return target\n\n# ✅ 正确: 不可变默认值\ndef process(items: Sequence[str] = ()) -> None:\n    ...\n\n# ❌ 危险: 可变默认参数在模块加载时创建一次，所有调用共享同一个对象\ndef append_to(item: int, target: list[int] = []) -> list[int]:\n    target.append(item)\n    return target\n\n# append_to(1) → [1]\n# append_to(2) → [1, 2]  ← 累积了!",
    "rationale": "Python 默认值在函数定义时求值一次，可变对象被所有调用共享"
  },
  "description": "Python: 不要使用可变对象作为默认参数",
  "kind": "pattern",
  "doClause": "Apply the Python pattern as described",
  "language": "python",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Python: 不要使用可变对象作为默认参数的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Python Style Guide §2.12; 最常见的 Python 陷阱之一",
    "sources": [
      "Google Python Style Guide §2.12",
      "PEP 8"
    ],
    "confidence": 0.95
  }
}
```

---

## 13. Python 特有维度 (extraDimensions)

冷启动分析 Python 项目时，除了通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **类型安全** | type hints 覆盖率、mypy strict、Protocol 使用 | `code-standard` |
| **包管理** | pyproject.toml vs setup.py、依赖分组、lock 文件 | `config` |
| **异步模式** | asyncio / TaskGroup / async generator | `code-pattern` |
| **数据校验** | Pydantic model、dataclass、NamedTuple 选择 | `code-pattern` |
| **上下文管理** | with 语句覆盖率、自定义 context manager | `best-practice` |
| **框架模式** | Django ORM/Views、FastAPI routes、Flask blueprints | `code-pattern` |
| **测试模式** | pytest fixtures、parametrize、mock patch | `best-practice` |
| **文档** | docstring 覆盖率、Google/NumPy style | `code-standard` |

---

## 关联 Skills

- **autosnippet-coldstart**: 冷启动分析模板
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-java**: Java 业界最佳实践参考
- **autosnippet-reference-kotlin**: Kotlin 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
