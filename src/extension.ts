	const findWorkspaceForPath = (p: string): vscode.WorkspaceFolder | undefined => {
		const wss = vscode.workspace.workspaceFolders || [];
		for (const wf of wss) {
			try {
				const rel = path.relative(wf.uri.fsPath, p);
				if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
					return wf;
				}
			} catch {
				// ignore
			}
		}
		return undefined;
	};

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "DBG Tools" is now active!');

	// Create an output channel for all messages (no pop-up dialogs)
	const output = vscode.window.createOutputChannel('DBG Tools');
	context.subscriptions.push(output);

	// Helper: resolve modules directory to absolute path when possible
		const resolveModulesDir = (argDir?: string): string | undefined => {
		const config = vscode.workspace.getConfiguration();
		const configured = config.get<string>('dbg.modulesPath') || '';
		let modulesDir = (argDir && argDir.trim()) ? argDir.trim() : ((configured && configured.trim()) ? configured.trim() : '');
		if (!modulesDir) {
			const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
			if (!ws) { return undefined; }
			return path.join(ws.uri.fsPath, '.vscode', 'user-modules');
		}
		if (!path.isAbsolute(modulesDir) && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			modulesDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, modulesDir);
		}
		return modulesDir;
	};

	// Reusable implementation that executes modules in modulesDir and writes cache atomically
	const runModulesImpl = async (modulesDir: string, reason: string): Promise<void> => {
		try {
			if (!fs.existsSync(modulesDir) || !fs.statSync(modulesDir).isDirectory()) {
				output.appendLine(`[ERROR] 模块目录不存在或不是目录: ${modulesDir}`);
				return;
			}

			// choose per-workspace cache when possible
			const ownerWs = findWorkspaceForPath(modulesDir);
			const cachePath = await ensureCachePath(context, ownerWs);
			let sharedObj: any = {};
			if (fs.existsSync(cachePath)) {
				try {
					const raw = fs.readFileSync(cachePath, 'utf8');
					sharedObj = JSON.parse(raw || '{}');
				} catch (e) {
					output.appendLine('[WARN] 读取缓存失败，使用空对象继续执行。');
					sharedObj = {};
				}
			}

			const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));
			if (files.length === 0) {
				output.appendLine('[INFO] 模块目录中没有找到 .js 文件。');
				return;
			}

			output.appendLine(`[AUTO] 开始执行 ${files.length} 个模块（触发原因：${reason}）`);

			// Prepare host object to expose controlled host APIs to modules.
			// Contract for module function: function(host, shared)
			// host: { context, workspaceFolders, output, getConfig(section?), cachePath }
			const host = {
				context,
				workspaceFolders: vscode.workspace.workspaceFolders,
				output,
				getConfig: (section?: string) => vscode.workspace.getConfiguration(section),
				cachePath,
				ownerWs
			};

			for (const file of files) {
				const filePath = path.join(modulesDir, file);
				try {
					try { delete require.cache[require.resolve(filePath)]; } catch {}
					const mod = require(filePath);
					const fn = mod && (mod.default || mod);
					if (typeof fn === 'function') {
						// Pass host first, then shared object. Allow modules to read host data and mutate shared.
						await Promise.resolve(fn(host, sharedObj));
					} else {
						output.appendLine(`[WARN] 模块 ${filePath} 导出不是函数，已跳过。`);
					}
				} catch (err) {
					output.appendLine(`[ERROR] 加载或执行模块 ${file} 时出错: ${String(err)}`);
				}
			}

			// atomic write: write to tmp then rename
			try {
				const tmp = cachePath + '.tmp';
				fs.writeFileSync(tmp, JSON.stringify(sharedObj, null, 2), 'utf8');
				fs.renameSync(tmp, cachePath);
				output.appendLine(`[INFO] 已执行 ${files.length} 个模块，缓存已写入。`);
			} catch (e) {
				output.appendLine('[ERROR] 写入缓存失败：' + String(e));
			}
		} catch (e) {
			output.appendLine('[ERROR] 运行用户模块时发生错误：' + String(e));
		}
	};

	// Refresh controller: debounce, mutex, watcher and optional interval
	class RefreshController {
		private timer: NodeJS.Timeout | undefined;
		private isRunning = false;
		private requestPending = false;
		private watcherDisposable: vscode.Disposable | undefined;
		private intervalId: NodeJS.Timeout | undefined;

		constructor(private modulesDir: string | undefined) {}

		public scheduleRefresh(reason = 'scheduled') {
			const cfg = vscode.workspace.getConfiguration();
			const debounceMs = cfg.get<number>('dbg.refreshDebounceMs') || 800;
			if (this.timer) { clearTimeout(this.timer); }
			this.timer = setTimeout(() => this.runRefresh(reason), debounceMs);
			output.appendLine(`[AUTO] 刷新已调度（${reason}），防抖 ${debounceMs}ms`);
		}

		private async runRefresh(reason: string) {
			if (!this.modulesDir) {
				output.appendLine('[AUTO] 未配置或无法解析模块目录，跳过自动刷新。');
				return;
			}
			if (this.isRunning) {
				this.requestPending = true;
				output.appendLine('[AUTO] 刷新已在进行，标记为 pending');
				return;
			}
			this.isRunning = true;
			try {
				await runModulesImpl(this.modulesDir, reason);
			} finally {
				this.isRunning = false;
				if (this.requestPending) {
					this.requestPending = false;
					// schedule another run (use short delay)
					this.scheduleRefresh('pending');
				}
			}
		}

		public startWatch() {
			// create watcher only if modulesDir is inside workspace
			if (!this.modulesDir) { return; }
			const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
			if (!ws) {
				output.appendLine('[AUTO] 无工作区，fileWatcher 不可用。');
				return;
			}
			let rel = path.relative(ws.uri.fsPath, this.modulesDir);
			if (rel.startsWith('..')) {
				output.appendLine('[AUTO] 模块目录不在工作区内，fileWatcher 被禁用。');
				return;
			}
			const pattern = new vscode.RelativePattern(ws, path.join(rel, '**', '*.js'));
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			const onChange = (uri: vscode.Uri) => this.scheduleRefresh('file-change');
			watcher.onDidCreate(onChange, this, context.subscriptions);
			watcher.onDidChange(onChange, this, context.subscriptions);
			watcher.onDidDelete(onChange, this, context.subscriptions);
			this.watcherDisposable = watcher;
			context.subscriptions.push(watcher);
			output.appendLine('[AUTO] 文件变更监视已启用：' + this.modulesDir);
		}

		public startInterval() {
			const secs = vscode.workspace.getConfiguration().get<number>('dbg.refreshIntervalSeconds') || 0;
			if (secs <= 0) { return; }
			this.intervalId = setInterval(() => this.scheduleRefresh('interval'), secs * 1000);
			context.subscriptions.push({ dispose: () => { if (this.intervalId) { clearInterval(this.intervalId); } } });
			output.appendLine('[AUTO] 周期性刷新已启用，间隔 ' + secs + 's');
		}

		public dispose() {
			if (this.timer) { clearTimeout(this.timer); }
			if (this.watcherDisposable) { this.watcherDisposable.dispose(); }
			if (this.intervalId) { clearInterval(this.intervalId); }
		}
	}

	// The command implementations are registered below (runModules, get)

	// Run user modules from a specified directory. Each module should export a function
	// that accepts a shared object and may mutate it. The shared object is cached to disk.
	const runModules = vscode.commands.registerCommand('dbg.runModules', async (...args: any[]) => {
		try {
			const config = vscode.workspace.getConfiguration();
			const configured = config.get<string>('dbg.modulesPath') || '';
			// Determine modules directory: priority -> command arg -> configured -> workspace .vscode/user-modules
			const argDir = (args && args.length > 0 && typeof args[0] === 'string') ? args[0].trim() : '';
			let modulesDir = argDir || ((configured && configured.trim()) ? configured.trim() : '');
			if (!modulesDir) {
				// use workspace .vscode/user-modules as default when available
				const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
				if (ws) {
					modulesDir = path.join(ws.uri.fsPath, '.vscode', 'user-modules');
				} else {
					output.appendLine('[WARN] 未指定模块目录，且未打开工作区，无法使用默认目录。命令不会弹出输入框，请以参数形式调用。');
					return;
				}
			}
			// If workspace folder exists and input is relative, resolve against first workspace folder
			if (!path.isAbsolute(modulesDir) && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
				modulesDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, modulesDir);
			}

			if (!fs.existsSync(modulesDir) || !fs.statSync(modulesDir).isDirectory()) {
				output.appendLine(`[ERROR] 模块目录不存在或不是目录: ${modulesDir}`);
				return;
			}

			// choose per-workspace cache when possible
			const ownerWs = findWorkspaceForPath(modulesDir);
			const cachePath = await ensureCachePath(context, ownerWs);
			let sharedObj: any = {};
			if (fs.existsSync(cachePath)) {
				try {
					const raw = fs.readFileSync(cachePath, 'utf8');
					sharedObj = JSON.parse(raw || '{}');
				} catch (e) {
					output.appendLine('[WARN] 读取缓存失败，使用空对象继续执行。');
					sharedObj = {};
				}
			}

			const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));
				if (files.length === 0) {
				output.appendLine('[INFO] 模块目录中没有找到 .js 文件。');
				return;
			}

			// prepare host object for modules
			const host = {
				context,
				workspaceFolders: vscode.workspace.workspaceFolders,
				output,
				getConfig: (section?: string) => vscode.workspace.getConfiguration(section),
				cachePath,
				ownerWs
			};

			for (const file of files) {
				const filePath = path.join(modulesDir, file);
				try {
					// Clear require cache to allow reloading during development
					try { delete require.cache[require.resolve(filePath)]; } catch {}
					// load module via require
					const mod = require(filePath);
					const fn = mod && (mod.default || mod);
					if (typeof fn === 'function') {
						// Pass host first, then shared object so module can access host helpers.
						await Promise.resolve(fn(host, sharedObj));
					} else {
						console.warn(`模块 ${filePath} 导出不是函数，已跳过。`);
					}
				} catch (err) {
					console.error(`加载或执行模块 ${file} 时出错:`, err);
					// 继续执行其它模块
				}
			}

			// persist cache
				try {
				fs.writeFileSync(cachePath, JSON.stringify(sharedObj, null, 2), 'utf8');
				output.appendLine(`[INFO] 已执行 ${files.length} 个模块，缓存已写入。`);
			} catch (e) {
				output.appendLine('[ERROR] 写入缓存失败：' + String(e));
			}

		} catch (e) {
			output.appendLine('[ERROR] 运行用户模块时发生错误：' + String(e));
		}
	});
	context.subscriptions.push(runModules);

	// Provide a simple command to get a property value from the cached shared object
	// NOTE: this command now only accepts a single string argument: dbg.get('myKey')
	const getValue = vscode.commands.registerCommand('dbg.get', async (...args: any[]) => {
		let key: string | undefined;
		if (args && args.length > 0 && typeof args[0] === 'string') {
			key = args[0];
		}
		if (!key) {
			// Only accept a string argument. Do not prompt; return 'undefined' string.
			output.appendLine('[WARN] dbg.get 现在只接受单个字符串参数，例如 dbg.get("myKey")；未提供合法字符串参数，返回 "undefined"。');
			return 'undefined';
		}
		try {
			const cachePath = await ensureCachePath(context);
			if (!fs.existsSync(cachePath)) {
				// No cache exists — likely modules haven't been run yet
				output.appendLine('[WARN] 缓存文件不存在（可能尚未运行任何模块），返回 "undefined" 字符串。请先运行 dbg.runModules。');
				return 'undefined';
			}
			const raw = fs.readFileSync(cachePath, 'utf8');
			const obj = JSON.parse(raw || '{}');
			const val = obj[key];
			const msg = `key=${key} value=${typeof val === 'string' ? val : JSON.stringify(val)}`;
			output.appendLine('[INFO] ' + msg);
			// Ensure we always return a string
			if (typeof val === 'string') {
				return val;
			}
			if (val === undefined) {
				return 'undefined';
			}
			try {
				return JSON.stringify(val);
			} catch (e) {
				return String(val);
			}
		} catch (e) {
			output.appendLine('[ERROR] 读取缓存失败：' + String(e));
			return 'undefined';
		}
	});
	context.subscriptions.push(getValue);
}

// This method is called when your extension is deactivated
export function deactivate() {}

async function ensureCachePath(context: vscode.ExtensionContext, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
	// Behavior:
	// - If user set configuration `dbg.cachePath`, use that (file path or directory).
	//   If relative, resolve against first workspace folder.
	// - Otherwise, default to <workspace>/.vscode/dbg/modulesCache.json when a workspace is open.
	// - If no workspace, fall back to OS tmp directory.
	const cfg = vscode.workspace.getConfiguration();
	const configured = cfg.get<string>('dbg.cachePath') || '';

	// helper to ensure dir exists
	const ensureDir = (dir: string) => {
		if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	};

	// If user explicitly configured a cache path, honor it
	if (configured && configured.trim()) {
		let resolved = configured.trim();
		const ws = workspaceFolder || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
		if (!path.isAbsolute(resolved) && ws) {
			resolved = path.join(ws.uri.fsPath, resolved);
		}
		try {
			// If it looks like a directory (exists and is directory) -> use it and append default filename
			if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
				ensureDir(resolved);
				return path.join(resolved, 'modulesCache.json');
			}
			// Otherwise treat as a file path (may not yet exist). Ensure parent dir exists.
			const parent = path.dirname(resolved) || resolved;
			ensureDir(parent);
			const fileName = path.basename(resolved) || 'modulesCache.json';
			return path.join(parent, fileName);
		} catch (e) {
			// fallback to workspace/default below
		}
	}

	const ws = workspaceFolder || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
	if (ws) {
		const storagePath = path.join(ws.uri.fsPath, '.vscode', 'dbg');
		ensureDir(storagePath);
		return path.join(storagePath, 'modulesCache.json');
	}

	// last resort: use tmp dir
	const tmpBase = path.join(require('os').tmpdir(), 'dbg');
	ensureDir(tmpBase);
	return path.join(tmpBase, 'modulesCache.json');
}
