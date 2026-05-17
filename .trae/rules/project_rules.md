# ComfyUI_BrotherPao 开发规则

## 项目概述

ComfyUI 自定义节点插件包，提供图像内补裁剪/拼接、图像分块/拼接、颜色匹配、图像对比、百度翻译、字典操作等功能。

## 项目结构

```
ComfyUI_BrotherPao/
├── __init__.py              # 插件入口，注册节点和路由
├── routes.py                # aiohttp API 路由（配置读写）
├── config_manager.py        # 配置文件管理（原子写入、线程安全）
├── nodes/
│   ├── __init__.py          # 节点注册汇总，含重复 key 检查
│   ├── utils.py             # 共享工具函数（pil2tensor, tensor2pil）
│   ├── BaiduTranslate.py    # 百度翻译 API 节点
│   ├── DictionaryNodes.py   # 字典操作节点
│   ├── ImageColorMatch.py   # 图像颜色匹配节点
│   ├── ImageCompare.py      # 图像对比节点（OUTPUT_NODE）
│   ├── ImageTileNodes.py    # 图像分块/拼接节点
│   └── InpaintCropAndStitch.py  # 内补裁剪/拼接节点
├── web/
│   ├── shared_utils.js      # 共享 JS 工具（translateComboWidget, applyZhLabels）
│   ├── contextMenu.js       # 右键菜单嵌套子目录
│   ├── dict_update_dynamic.js  # 字典合并动态输入
│   ├── image_compare_node.js   # 图像对比滑块 UI
│   ├── inpaint_showcontrol.js  # 内补节点控件联动
│   └── node_labels.js       # 节点标签中文翻译
├── pyproject.toml           # 项目元数据和依赖
├── requirements.txt         # pip 依赖
└── config.json.example      # 配置文件示例
```

## 编码规范

### Python

1. **类型系统**：自定义类型（如 `TILE_INFO`、`STITCHER`）通过 dict 传递，使用 `"class"` 键标识类型。新增自定义类型时需在文档中说明结构。
2. **错误处理**：
   - 不向用户暴露内部异常详情（`str(e)`），使用通用错误消息
   - 内部异常通过 `logging` 记录完整信息
   - API 路由返回通用错误消息，详细错误写日志
3. **原子写入**：配置文件使用 `tempfile` + `os.replace` 模式，异常时清理临时文件
4. **线程安全**：配置读写使用 `threading.RLock` 保护
5. **性能**：
   - 避免像素级逐点操作，优先使用 NumPy/PIL 批量构建
   - GPU/CPU 共享逻辑提升到基类，仅 GPU 特有实现放在子类
   - 避免重复的 tensor↔PIL 转换，先转换再传入条件
6. **导入**：不导入未使用的模块。`torch`、`numpy`、`PIL` 等由 ComfyUI 环境隐式提供，但 `pillow` 需在 `pyproject.toml` 中声明
7. **节点注册**：新增节点时在 `nodes/__init__.py` 中注册，合并函数会自动检测 key 冲突
8. **日志**：使用 `logging.getLogger(__name__)` 而非 `print()`

### JavaScript

1. **变量声明**：使用 `const` 和 `let`，禁止使用 `var`
2. **共享模块**：中文标签翻译和 combo 控件翻译使用 `web/shared_utils.js` 中的 `applyZhLabels` 和 `translateComboWidget`
3. **定时器**：
   - 使用 `requestAnimationFrame` 替代多重 `setTimeout` 碰运气
   - 轮询检测必须设置最大重试次数（如 `MAX_PATCH_RETRIES = 50`）
4. **属性劫持**：`Object.defineProperty` 劫持 widget 的 `value` 属性时必须包裹 `try-catch`，防止 ComfyUI 内部变更导致崩溃
5. **扩展注册**：每个 JS 文件通过 `app.registerExtension()` 注册，扩展名格式为 `ComfyUI_BrotherPao.XXX`

### 安全

1. **凭据管理**：API 密钥存储在 `config.json` 中（已被 `.gitignore` 排除），不得提交到版本库
2. **HTTPS**：外部 API 调用必须使用 HTTPS
3. **错误脱敏**：不向用户界面返回可能包含敏感信息的原始异常消息

## 节点开发流程

1. 在 `nodes/` 下创建新节点文件，定义 `NODE_CLASS_MAPPINGS` 和 `NODE_DISPLAY_NAME_MAPPINGS`
2. 在 `nodes/__init__.py` 中导入并添加到合并列表
3. 如需前端扩展，在 `web/` 下创建 JS 文件，使用 `app.registerExtension()` 注册
4. 中文标签翻译：在对应 JS 文件中定义 `ZH_LABEL_MAP`，使用 `applyZhLabels` 应用
5. Combo 控件翻译：使用 `translateComboWidget` 并提供 `enToZh` 和 `zhToEn` 映射

## 依赖管理

- `pyproject.toml` 和 `requirements.txt` 必须保持同步
- 显式依赖：`requests`、`color-matcher`、`scipy`、`pillow`
- 隐式依赖（ComfyUI 环境提供）：`torch`、`torchvision`、`numpy`
- 新增依赖时同时更新 `pyproject.toml` 和 `requirements.txt`

## 测试

- 框架：`pytest`，配置在 `pyproject.toml` 的 `[tool.pytest.ini_options]`
- 运行命令：`python -m pytest tests/ -v`（需使用 ComfyUI 的 Python 环境）
- 测试目录：`tests/`，包含 `conftest.py`（mock `comfy`、`nodes`、`server` 模块）
- 测试文件：
  - `test_inpaint.py`：`ProcessorLogic` 基类、CPU/GPU 子类、`crop_magic_im`、`stitch_magic_im`、`InpaintCropImproved`、`InpaintStitchImproved`
  - `test_tile_nodes.py`：`make_tile_info`、渐变遮罩、`ImageTileBatch`、`ImageResolutionDivider`、`ImageAssemble`、`pil2tensor`/`tensor2pil`
  - `test_dict_nodes.py`：`DictionaryNew`、`DictionaryGet`（含非 dict 输入边界测试）、`DictionaryUpdate`
- Mock 策略：`conftest.py` 在模块级别注入 `sys.modules` mock，使 `comfy.model_management`、`nodes`、`server` 在测试环境中可用
- `__init__.py` 使用 `try/except ImportError` 包裹节点导入，确保测试环境下不会因缺少 ComfyUI 依赖而崩溃
- 新增测试：在 `tests/` 下创建 `test_<模块名>.py`，使用 `from ComfyUI_BrotherPao.nodes.<模块> import ...` 导入

## 命名规范

- 节点注册名：`BrotherPao_<功能名>`（如 `BrotherPao_ImageCompare`）
- 节点显示名：中文（如 `图像对比`）
- 分类：`❤️‍🩹炮哥Nodes/<子分类>`
- JS 扩展名：`ComfyUI_BrotherPao.<功能名>`
