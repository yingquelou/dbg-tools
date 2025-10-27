# DBG Tools

DBG Tools 允许你在工作区内（或指定目录）运行一组用户自定义的 JavaScript 模块，这些模块会接收并修改一个共享对象，扩展会把该对象缓存到每个工作区各自的 `.vscode/dbg/modulesCache.json`（除非你通过配置覆盖），并提供读取缓存值的命令。

快速上手

1. 在工作区中创建默认模块目录（可选，扩展也会自动使用 `.vscode/user-modules` 作为模块目录）：

```
<workspace>/.vscode/user-modules/
```

2. 在该目录中添加模块（示例模块）。模块导出函数签名为 function(host, shared)：

```js
// example.js
// 新签名：module.exports = function(host, shared) { ... }
module.exports = function(host, shared) {
	// 修改共享对象
	shared.example = shared.example ? shared.example + 1 : 1;

	/* 
	// host 提供若干只读/辅助功能
		host = {
				context, 			// 扩展上下文
				workspaceFolders, 	// 编辑器中打开的工作区文件夹列表
				output, 			// 扩展绑定的vscode通道面板
				getConfig: (section?: string) => vscode.workspace.getConfiguration(section),
				cachePath,			// 共享对象缓存目录
				ownerWs				// 当前模块所属workspaceFolder
			};
	 */
	if (host && host.output) {
		host.output.appendLine(`[example.js] ran; example=${shared.example}`);
	}
};
```
3. 在.vscode目录下的tasks.json、launch.json或其他可用处访问共享对象的属性
```json
// .vscode/tasks.json
{
	"version": "2.0.0",
	"tasks": [
		{
			"type": "shell",
			"label": "demo",
			"command": "echo",
			"args": [
				"${input:example}"
			]
		}
	],
	"inputs": [
		{
			"id": "example",
			"type": "command",
			"command": "dbg.get",
			"args": "example"
		},
		{
			"id": "runModules",
			"type": "command",
			"command": "dbg.runModules"
		}
	]
}
```
3. 在 VS Code 中打开命令面板（Ctrl+Shift+P）运行：

- `dbg.runModules` — 执行目录中所有 `.js` 模块。
命令不会弹出输入框；可通过命令参数传入目录（优先级：命令参数 → 设置 `dbg.modulesPath` → 默认 `<workspace>/.vscode/user-modules`）。

模块导出函数签名： `function(host, shared)`，host 包含受控的宿主功能（见下文）。

- `dbg.get` — 获取缓存对象中的指定 key。

仅接受单个字符串参数，例如 `dbg.get("example")`，其它调用形态将返回字符串 "undefined" 并在输出通道写入警告。

配置

在设置中你可以配置：
- `dbg.modulesPath`（相对工作区根或绝对路径），决定默认的模块目录；
- `dbg.cachePath`（可选，文件或目录，相对工作区根或绝对路径），如果设置则覆盖默认缓存位置；

默认行为：如果未配置 `dbg.cachePath`，扩展会为每个打开的工作区在 `<workspace>/.vscode/dbg/modulesCache.json` 存放该工作区的缓存文件（当使用多工作区时，每个工作区拥有自己的缓存）。如果没有打开任何工作区，扩展会回退到系统临时目录。

缓存位置示例：

```
<workspace>/.vscode/dbg/modulesCache.json
```

安全说明

扩展会 `require` 并执行用户目录下的 JavaScript 文件。请仅在信任的代码上使用此功能。模块运行时能访问到 `host` 对象中提供的一些宿主能力（例如日志输出与读取配置），但为了安全仍应只在受信任的模块上运行。如果需要更高安全性，请将模块代码放入受控环境或使用独立进程/沙箱执行。

反馈与贡献

欢迎在仓库中提交 issue 或 PR，描述使用中遇到的问题或改进建议。
