#!/usr/bin/env node
import process$1, { cwd } from "node:process";
import { chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { Buffer as Buffer$1 } from "node:buffer";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, normalize, resolve } from "node:path";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
// ../../node_modules/.pnpm/@moeru+std@0.1.0-beta.20/node_modules/@moeru/std/dist/error/index.js
const isError = (err) => {
	if ("isError" in Error && Error.isError(new DOMException())) return Error.isError(err);
	if (err === null || typeof err !== "object" && typeof err !== "function") return false;
	if (err instanceof Error) return true;
	const tag = Object.prototype.toString.call(err);
	return tag === "[object DOMException]" || tag === "[object Error]";
};
const isErrorLike = (err) => {
	if (isError(err)) return true;
	if (err == null || typeof err !== "object" && typeof err !== "function") return false;
	return "message" in err && typeof err.message === "string" && "name" in err && typeof err.name === "string";
};
const errorMessageFrom = (err) => isErrorLike(err) ? err.message : err == null ? void 0 : String(err);
// src/fatal-diagnostic.ts
const budgetBytes = 10485760;
const directory = join(tmpdir(), "alint-stop-gate", "fatal");
const terminalPunctuation = /[.!?]$/u;
const truncationMarker = "\nNOTICE: fatal diagnostic truncated to fit the 10 MiB budget.\n";
function reportFatalFailure(context, error) {
	const detail = errorMessageFrom(error) ?? "unknown error";
	const diagnostic = writeFatalDiagnostic(context, detail);
	const failureDetail = `${context}: ${detail}`;
	const failure = `alint-plugin: Stop Gate hook runtime error. ${failureDetail}${terminalPunctuation.test(failureDetail) ? "" : "."}`;
	const writeError = diagnostic.writeError ?? "unknown error";
	const guidance = diagnostic.path === void 0 ? `The error diagnostic could not be saved: ${writeError}${terminalPunctuation.test(writeError) ? "" : "."} Explain this failure to the user.` : `Read the error details at "${diagnostic.path}", then explain to the user how to fix the hook failure.${diagnostic.cleanupError === void 0 ? "" : ` Old diagnostic cleanup also failed: ${diagnostic.cleanupError}${terminalPunctuation.test(diagnostic.cleanupError) ? "" : "."}`}`;
	writeSync(process$1.stderr.fd, `${failure}\n${guidance}\n`);
	process$1.exitCode = 1;
}
function writeFatalDiagnostic(context, detail) {
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	const fileName = `${timestamp.replaceAll(":", "-").replaceAll(".", "-")}-${process$1.pid}.log`;
	const path = join(directory, fileName);
	try {
		mkdirSync(directory, {
			mode: 448,
			recursive: true
		});
		writeFileSync(path, diagnosticContent(timestamp, context, detail), {
			flag: "wx",
			mode: 420
		});
		chmodSync(path, 420);
	} catch (error) {
		return { writeError: errorMessageFrom(error) ?? "unknown error" };
	}
	try {
		enforceBudget();
		return { path };
	} catch (error) {
		return {
			cleanupError: errorMessageFrom(error) ?? "unknown error",
			path
		};
	}
}
function diagnosticContent(timestamp, context, detail) {
	const content = Buffer$1.from(`timestamp: ${timestamp}\ncontext: ${context}\ndetail: ${detail}\n`);
	if (content.byteLength <= budgetBytes) return content;
	const marker = Buffer$1.from(truncationMarker);
	return Buffer$1.concat([content.subarray(0, budgetBytes - marker.byteLength), marker]);
}
function enforceBudget() {
	const diagnostics = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".log")).map((entry) => {
		const path = join(directory, entry.name);
		const stats = statSync(path);
		return {
			mtimeMs: stats.mtimeMs,
			path,
			size: stats.size
		};
	});
	let total = diagnostics.reduce((sum, diagnostic) => sum + diagnostic.size, 0);
	for (const diagnostic of diagnostics.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
		if (total <= budgetBytes) break;
		unlinkSync(diagnostic.path);
		total -= diagnostic.size;
	}
}
function applyResult(state, envelope, now = /* @__PURE__ */ new Date()) {
	if (envelope.status === "inactive" || envelope.status === "no-dirty-files") return {
		decision: {},
		state: envelope.status === "inactive" ? updateState(state, now, {
			lastFindings: void 0,
			lintRounds: 0,
			runtimeFailures: 0
		}) : updateState(state, now, {
			lastFindings: void 0,
			runtimeFailures: 0
		})
	};
	if (envelope.status === "runtime-error") {
		const next = updateState(state, now, {
			lastFindings: void 0,
			runtimeFailures: state.runtimeFailures + 1
		});
		const message = runtimeErrorMessage(envelope);
		return {
			decision: next.runtimeFailures === 1 ? {
				decision: "block",
				reason: message
			} : { systemMessage: message },
			state: next
		};
	}
	const lintRounds = state.lintRounds + 1;
	const repeatedFindings = envelope.status === "errors" || envelope.status === "warnings" ? state.lastFindings?.findingsHash === envelope.findingsHash : false;
	const next = updateState(state, now, {
		lastFindings: envelope.status === "errors" || envelope.status === "warnings" ? {
			errorCount: envelope.errorCount,
			findingsHash: envelope.findingsHash,
			reportPath: envelope.reportPath,
			status: envelope.status,
			warningCount: envelope.warningCount
		} : void 0,
		lintRounds,
		runtimeFailures: 0
	});
	if (envelope.status === "clean") return {
		decision: {},
		state: next
	};
	const message = next.lastFindings === void 0 || envelope.reportPath === void 0 ? "" : repeatedFindings ? `alint-plugin: The same ${next.lastFindings.errorCount} error(s) and ${next.lastFindings.warningCount} warning(s) remain unchanged from the previous automatic lint. Stop Gate is allowing this turn to finish. The report remains at "${envelope.reportPath}".` : `alint-plugin: ${next.lastFindings.errorCount} error(s), ${next.lastFindings.warningCount} warning(s). Review the report at "${envelope.reportPath}" carefully. Act only on findings that are valid, valuable, and relevant to the current uncommitted changes. Do not make opportunistic changes merely to silence findings, such as deleting code, ignoring files, disabling rules, or changing the alint configuration. If you determine that none of reports are valid or valuable, just do nothing, next time the gate will allowing this turn to finish.`;
	return {
		decision: (envelope.status === "errors" ? lintRounds < 9 && !repeatedFindings : lintRounds === 1) ? {
			decision: "block",
			reason: message
		} : { systemMessage: message },
		state: next
	};
}
function lintLimitDecision(state) {
	return { systemMessage: state.lastFindings === void 0 ? `alint-plugin: Stop Gate reached the maximum of 9 successful lint rounds for this session. The latest lint completed with no findings, so no report was written.` : `alint-plugin: ${state.lastFindings.errorCount} error(s), ${state.lastFindings.warningCount} warning(s). Review the report at "${state.lastFindings.reportPath}" carefully. Act only on findings that are valid, valuable, and relevant to the current uncommitted changes. Do not make opportunistic changes merely to silence findings, such as deleting code, ignoring files, disabling rules, or changing the alint configuration. If you determine that none of reports are valid or valuable, just do nothing, next time the gate will allowing this turn to finish.` };
}
function runtimeErrorMessage(error) {
	const instruction = error.reportPath === void 0 ? "Do not attempt to fix it yourself. Explain the error to the user and suggest how to fix it." : `Do not attempt to fix it yourself. Read the error details at "${error.reportPath}", then explain to the user how to fix the failures.`;
	return `alint-plugin: Runtime error: ${error.message}\n${instruction}`;
}
function updateState(state, now, patch) {
	return {
		...state,
		...patch,
		schemaVersion: 2,
		updatedAt: now.toISOString()
	};
}
// ../../node_modules/.pnpm/tinyexec@1.3.1/node_modules/tinyexec/dist/main.mjs
const isPathLikePattern = /^path$/i;
const defaultEnvPathInfo = {
	key: "PATH",
	value: ""
};
function getPathFromEnv(env) {
	for (const key in env) {
		if (!Object.prototype.hasOwnProperty.call(env, key) || !isPathLikePattern.test(key)) continue;
		const value = env[key];
		if (!value) return defaultEnvPathInfo;
		return {
			key,
			value
		};
	}
	return defaultEnvPathInfo;
}
function addNodeBinToPath(cwd, path) {
	const parts = path.value.split(delimiter);
	const nodeBinPaths = [];
	let currentPath = typeof cwd === "string" ? cwd : fileURLToPath(cwd, { windows: false });
	let lastPath;
	do {
		nodeBinPaths.push(resolve(currentPath, "node_modules", ".bin"));
		lastPath = currentPath;
		currentPath = dirname(currentPath);
	} while (currentPath !== lastPath);
	nodeBinPaths.push(dirname(process.execPath));
	const newPath = nodeBinPaths.concat(parts).join(delimiter);
	return {
		key: path.key,
		value: newPath
	};
}
function computeEnv(cwd, env, nodePath = true) {
	const envWithDefault = {
		...process.env,
		...env
	};
	if (!nodePath) return envWithDefault;
	const envPathInfo = addNodeBinToPath(cwd, getPathFromEnv(envWithDefault));
	envWithDefault[envPathInfo.key] = envPathInfo.value;
	return envWithDefault;
}
const combineStreams = (streams) => {
	let streamCount = streams.length;
	const combined = new PassThrough();
	const maybeEmitEnd = () => {
		if (--streamCount === 0) combined.end();
	};
	for (const stream of streams) pipeline(stream, combined, { end: false }).then(maybeEmitEnd).catch(maybeEmitEnd);
	return combined;
};
const metaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;
const shebangRegExp = /^#!\s*(.+)/;
const isWindowsExecutableRegExp = /\.(?:com|exe)$/i;
const isNodeModulesCmdRegExp = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const isWindows = process.platform === "win32";
const defaultPathExt = [
	".EXE",
	".CMD",
	".BAT",
	".COM"
];
const noPathExt = [""];
/**
* Normalizes the command and arguments to work cross-platform.
* On Windows, this basically handles things like shebangs, calling
* `node_modules/.bin` commands, and escaping meta characters.
* On other platforms, it just returns the command and arguments as-is.
*/
function normalizeSpawnCommand(command, args = [], options = {}) {
	if (options.shell === true || !isWindows) return {
		command,
		args,
		options
	};
	let file = resolveCommand(command, options);
	let shebang = null;
	if (file !== null) {
		const size = 150;
		const buffer = Buffer.alloc(size);
		let fd = null;
		try {
			fd = openSync(file, "r");
			readSync(fd, buffer, 0, size, 0);
		} catch {} finally {
			if (fd !== null) closeSync(fd);
		}
		const match = buffer.toString().match(shebangRegExp);
		if (match !== null) {
			const line = match[1].trim();
			const separatorIndex = line.indexOf(" ");
			const path = separatorIndex !== -1 ? line.slice(0, separatorIndex) : line;
			const argument = separatorIndex !== -1 ? line.slice(separatorIndex + 1) : "";
			const binary = basename(path);
			shebang = binary === "env" ? argument || null : binary;
		}
	}
	if (shebang !== null && file !== null) {
		args = [file, ...args];
		command = shebang;
		file = resolveCommand(command, options);
	}
	if (file === null || !isWindowsExecutableRegExp.test(file)) {
		const needsDoubleEscapeMetaChars = file !== null && isNodeModulesCmdRegExp.test(file);
		command = normalize(command);
		command = command.replace(metaCharsRegExp, "^$1");
		args = args.map((arg) => {
			arg = arg.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
			arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
			arg = `"${arg}"`;
			arg = arg.replace(metaCharsRegExp, "^$1");
			if (needsDoubleEscapeMetaChars) arg = arg.replace(metaCharsRegExp, "^$1");
			return arg;
		});
		args = [
			"/d",
			"/s",
			"/c",
			`"${[command, ...args].join(" ")}"`
		];
		command = options.env?.comspec ?? "cmd.exe";
		options = {
			...options,
			windowsVerbatimArguments: true
		};
	}
	return {
		command,
		args,
		options
	};
}
/**
* Resolves the command to an absolute path if possible.
* Handles things like traversing PATH and adding extensions from PATHEXT
*/
function resolveCommand(command, options) {
	const cwd$3 = (options.cwd ?? cwd()).toString();
	const env = options.env ?? process.env;
	const PATH = getPathFromEnv(env).value;
	const pathEnv = command.includes("/") || command.includes("\\") ? [""] : [cwd$3, ...PATH.split(delimiter)];
	let pathExt = env.PATHEXT ? env.PATHEXT.split(delimiter) : defaultPathExt;
	if (command.includes(".") && pathExt[0] !== "") pathExt = ["", ...pathExt];
	for (const extensions of [pathExt, noPathExt]) for (const path of pathEnv) {
		const unquoted = path.startsWith("\"") && path.endsWith("\"") && path.length > 1 ? path.slice(1, -1) : path;
		const dest = resolve(cwd$3, unquoted, command);
		for (const ext of extensions) {
			const destWithExt = dest + ext;
			try {
				if (statSync(destWithExt).isFile()) return destWithExt;
			} catch {}
		}
	}
	return null;
}
var NonZeroExitError = class extends Error {
	result;
	output;
	exitCode;
	get signalCode() {
		return this.result.signalCode;
	}
	constructor(result, output, command, args) {
		let target = "The process";
		if (command) target = `The command \`${args?.length ? `${command} ${args.map((a) => /[ "'`()]/.test(a) ? JSON.stringify(a) : a).join(" ")}` : command}\``;
		const exitCode = result.exitCode ?? 1;
		super(result.signalCode !== null ? `${target} was killed by the signal ${result.signalCode}` : `${target} exited with a non-zero status (${exitCode})`);
		this.result = result;
		this.output = output;
		this.exitCode = exitCode;
		Object.defineProperty(this, "result", {
			enumerable: false,
			writable: false,
			configurable: false
		});
	}
};
const defaultOptions = {
	timeout: void 0,
	persist: false
};
const defaultNodeOptions = { windowsHide: true };
function combineSignals(signals) {
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort();
			return signal;
		}
		const onAbort = () => {
			controller.abort(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { signal: controller.signal });
	}
	return controller.signal;
}
async function readStream(stream) {
	let output = "";
	try {
		for await (const chunk of stream) output += chunk.toString();
	} catch {}
	return output;
}
var ExecProcess = class {
	_process;
	_aborted = false;
	_options;
	_command;
	_args;
	_resolveClose;
	_processClosed;
	_thrownError;
	get process() {
		return this._process;
	}
	get pid() {
		return this._process?.pid;
	}
	get exitCode() {
		if (this._process && this._process.exitCode !== null) return this._process.exitCode;
	}
	get signalCode() {
		return this._process?.signalCode ?? null;
	}
	constructor(command, args, options) {
		this._options = {
			...defaultOptions,
			...options
		};
		this._command = command;
		this._args = args ?? [];
		this._processClosed = new Promise((resolve) => {
			this._resolveClose = resolve;
		});
	}
	kill(signal) {
		return this._process?.kill(signal) === true;
	}
	get aborted() {
		return this._aborted;
	}
	get killed() {
		return this._process?.killed === true;
	}
	pipe(command, args, options) {
		return exec(command, args, {
			...options,
			stdin: this
		});
	}
	async *[Symbol.asyncIterator]() {
		const proc = this._process;
		if (!proc) return;
		const streams = [];
		if (this._streamErr) streams.push(this._streamErr);
		if (this._streamOut) streams.push(this._streamOut);
		const streamCombined = combineStreams(streams);
		const rl = readline.createInterface({ input: streamCombined });
		for await (const chunk of rl) yield chunk.toString();
		await this._processClosed;
		proc.removeAllListeners();
		if (this._thrownError) throw this._thrownError;
		if (this._options?.throwOnError && (this.exitCode !== 0 && this.exitCode !== void 0 || this.signalCode !== null)) throw new NonZeroExitError(this, void 0, this._command, this._args);
	}
	async _waitForOutput() {
		const proc = this._process;
		if (!proc) throw new Error("No process was started");
		const [stdout, stderr] = await Promise.all([this._streamOut ? readStream(this._streamOut) : "", this._streamErr ? readStream(this._streamErr) : ""]);
		await this._processClosed;
		const { stdin } = this._options;
		if (stdin && typeof stdin !== "string") await stdin;
		proc.removeAllListeners();
		if (this._thrownError) throw this._thrownError;
		const result = {
			stderr,
			stdout,
			exitCode: this.exitCode
		};
		if (this._options.throwOnError && (this.exitCode !== 0 && this.exitCode !== void 0 || this.signalCode !== null)) throw new NonZeroExitError(this, result, this._command, this._args);
		return result;
	}
	then(onfulfilled, onrejected) {
		return this._waitForOutput().then(onfulfilled, onrejected);
	}
	_streamOut;
	_streamErr;
	spawn() {
		const options = this._options;
		const nodeOptions = {
			...defaultNodeOptions,
			...options.nodeOptions
		};
		const cwd$1 = nodeOptions?.cwd ?? cwd();
		const signals = [];
		this._resetState();
		if (options.timeout !== void 0) signals.push(AbortSignal.timeout(options.timeout));
		if (options.signal !== void 0) signals.push(options.signal);
		if (options.persist === true) nodeOptions.detached = true;
		if (signals.length > 0) nodeOptions.signal = combineSignals(signals);
		nodeOptions.env = computeEnv(cwd$1, nodeOptions.env, options.nodePath);
		const crossResult = normalizeSpawnCommand(this._command, this._args, nodeOptions);
		const handle = spawn(crossResult.command, crossResult.args, crossResult.options);
		if (handle.stderr) this._streamErr = handle.stderr;
		if (handle.stdout) this._streamOut = handle.stdout;
		this._process = handle;
		handle.once("error", this._onError);
		handle.once("close", this._onClose);
		if (handle.stdin) {
			const { stdin } = options;
			if (typeof stdin === "string") handle.stdin.end(stdin);
			else stdin?.process?.stdout?.pipe(handle.stdin);
		}
	}
	_resetState() {
		this._aborted = false;
		this._processClosed = new Promise((resolve) => {
			this._resolveClose = resolve;
		});
		this._thrownError = void 0;
	}
	_onError = (err) => {
		if (err.name === "AbortError" && (!(err.cause instanceof Error) || err.cause.name !== "TimeoutError")) {
			this._aborted = true;
			return;
		}
		this._thrownError = err;
	};
	_onClose = () => {
		if (this._resolveClose) this._resolveClose();
	};
};
const x = (command, args, userOptions) => {
	const proc = new ExecProcess(command, args, userOptions);
	proc.spawn();
	return proc;
};
const exec = x;
// src/repository.ts
const startupTimeoutMs$1 = 6e4;
const stderrExcerptLimitBytes$1 = 4096;
const stderrTruncationMarker$1 = "\n... stderr truncated ...\n";
async function findGitRoot(cwd) {
	const execution = x("git", ["rev-parse", "--show-toplevel"], commandOptions(cwd));
	const result = await execution;
	if (execution.killed) throw new Error("Git root discovery exceeded the 1 minute startup limit.");
	if (result.exitCode !== 0) return;
	return result.stdout.trim() || void 0;
}
async function hasProjectConfig(gitRoot) {
	return (await readdir(gitRoot, { withFileTypes: true })).some((entry) => entry.isFile() && entry.name.startsWith("alint.config."));
}
async function isHeadDetached(gitRoot) {
	const execution = x("git", [
		"symbolic-ref",
		"--quiet",
		"HEAD"
	], commandOptions(gitRoot));
	const result = await execution;
	if (execution.killed) throw new Error("Git HEAD inspection exceeded the 1 minute startup limit.");
	if (result.exitCode === 0) return false;
	if (result.exitCode === 1) return true;
	const detail = truncateStderr$1(result.stderr.trim());
	throw new Error(detail.length === 0 ? `Git HEAD inspection failed with exit code ${result.exitCode ?? "unknown"} and produced no stderr output.` : `Git HEAD inspection failed with exit code ${result.exitCode ?? "unknown"}: ${detail}`);
}
function commandOptions(cwd) {
	return {
		nodeOptions: { cwd },
		nodePath: false,
		timeout: startupTimeoutMs$1
	};
}
function truncateStderr$1(stderr) {
	const bytes = Buffer$1.from(stderr, "utf8");
	if (bytes.length <= stderrExcerptLimitBytes$1) return stderr;
	const markerBytes = Buffer$1.byteLength(stderrTruncationMarker$1);
	const excerptBytes = stderrExcerptLimitBytes$1 - markerBytes;
	const headBytes = Math.ceil(excerptBytes / 2);
	const tailBytes = Math.floor(excerptBytes / 2);
	let headEnd = headBytes;
	let tailStart = bytes.length - tailBytes;
	while (headEnd > 0 && ((bytes[headEnd] ?? 0) & 192) === 128) headEnd -= 1;
	while (tailStart < bytes.length && ((bytes[tailStart] ?? 0) & 192) === 128) tailStart += 1;
	return `${bytes.toString("utf8", 0, headEnd)}${stderrTruncationMarker$1}${bytes.toString("utf8", tailStart)}`;
}
// ../../packages/utils/dist/node.mjs
function isNodeErrorCode(error, code) {
	return error instanceof Error && "code" in error && error.code === code;
}
// src/protocol.ts
const startupTimeoutMs = 6e4;
const maximumStopGateTimeoutMs = 861e5;
const stderrExcerptLimitBytes = 4096;
const stderrTruncationMarker = "\n... stderr truncated ...\n";
async function executeStopGate(command, gitRoot, sessionId, lintTimeoutMs) {
	const timeout = createLongTimeout(Math.min(lintTimeoutMs + startupTimeoutMs, Number.MAX_SAFE_INTEGER));
	const execution = x(command.executable, [
		...command.args,
		"integrations",
		"stop-gate",
		"--session-id",
		sessionId
	], {
		nodeOptions: { cwd: gitRoot },
		nodePath: false,
		signal: timeout.signal
	});
	let result;
	try {
		result = await execution;
	} finally {
		timeout.dispose();
	}
	if (execution.aborted) throw new Error("alint did not finish within its configured lint timeout plus the 1 minute startup allowance.");
	const envelope = parseEnvelope(result.stdout);
	if (envelope === void 0) {
		if (result.exitCode === 1) {
			const detail = truncateStderr(result.stderr.trim());
			throw new Error(detail.length === 0 ? "alint Stop Gate exited abnormally with exit code 1 and produced no stderr output." : `alint Stop Gate exited abnormally with exit code 1: ${detail}`);
		}
		throw incompatibleAlintError();
	}
	if (result.exitCode !== (envelope.status === "runtime-error" ? 1 : 0)) throw new Error(`alint Stop Gate returned status "${envelope.status}" with unexpected exit code ${result.exitCode ?? "unknown"}.`);
	return envelope;
}
function parseConfigOutput(stdout) {
	const enabled = /^enabled: (true|false)(?: |$)/mu.exec(stdout)?.[1];
	const target = /^target: (all|dirty-files)(?: |$)/mu.exec(stdout)?.[1];
	const timeoutMs = Number(/^timeoutMs: (\S+)/mu.exec(stdout)?.[1]);
	if (enabled === void 0 || target !== "all" && target !== "dirty-files" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumStopGateTimeoutMs) return;
	return {
		enabled: enabled === "true",
		target,
		timeoutMs
	};
}
function parseEnvelope(stdout) {
	let value;
	try {
		value = JSON.parse(stdout.trim());
	} catch {
		return;
	}
	if (!isEnvelopeRecord(value)) return;
	const base = {
		errorCount: value.errorCount,
		schemaVersion: 2,
		warningCount: value.warningCount
	};
	if (value.status === "clean" || value.status === "inactive" || value.status === "no-dirty-files") return value.errorCount === 0 && value.warningCount === 0 ? {
		...base,
		status: value.status
	} : void 0;
	if (value.status === "runtime-error") return value.errorCount === 0 && value.warningCount === 0 && typeof value.message === "string" && value.message.length > 0 && (value.reportPath === void 0 || typeof value.reportPath === "string" && value.reportPath.length > 0) ? {
		...base,
		message: value.message,
		...typeof value.reportPath === "string" ? { reportPath: value.reportPath } : {},
		status: value.status
	} : void 0;
	if (value.status === "errors" || value.status === "warnings") return (value.status === "errors" ? value.errorCount > 0 : value.errorCount === 0 && value.warningCount > 0) && typeof value.findingsHash === "string" && /^[a-f0-9]{64}$/u.test(value.findingsHash) && typeof value.reportPath === "string" && value.reportPath.length > 0 ? {
		...base,
		findingsHash: value.findingsHash,
		reportPath: value.reportPath,
		status: value.status
	} : void 0;
}
async function probeStopGateConfig(command, gitRoot, deadline) {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) throw packageManagerTimeoutError(command);
	let execution;
	try {
		execution = x(command.executable, [
			...command.args,
			"config",
			"integrations",
			"stop-gate",
			"show"
		], {
			nodeOptions: { cwd: gitRoot },
			nodePath: false,
			timeout: remainingMs
		});
		const result = await execution;
		if (execution.killed) throw packageManagerTimeoutError(command);
		if (result.exitCode !== 0) {
			if (command.source === "local") {
				const detail = truncateStderr(result.stderr.trim());
				const exitCode = result.exitCode ?? "unknown";
				const reason = detail.length === 0 ? `exit code ${exitCode} with no stderr output` : `exit code ${exitCode}: ${detail}`;
				throw new Error(`The repository-local alint could not read Stop Gate configuration due to ${reason}. Run \`alint config integrations stop-gate show\` manually.`);
			}
			return;
		}
		if (result.stdout.trim().length === 0) {
			const detail = truncateStderr(result.stderr.trim());
			const stderrContext = detail.length === 0 ? "" : ` alint wrote to stderr: ${detail}`;
			throw new Error(`alint exited successfully but produced no Stop Gate configuration output. Run \`alint config integrations stop-gate show\` manually and make sure it writes the resolved configuration to stdout.${stderrContext}`);
		}
		const config = parseConfigOutput(result.stdout);
		if (config === void 0) throw incompatibleAlintError();
		return config;
	} catch (error) {
		if (execution?.killed) throw packageManagerTimeoutError(command);
		if (isNodeErrorCode(error, "ENOENT")) return;
		throw error;
	}
}
function createLongTimeout(timeoutMs) {
	const controller = new AbortController();
	let remainingMs = timeoutMs;
	let timer;
	const schedule = () => {
		const delay = Math.min(remainingMs, 2147483647);
		timer = setTimeout(() => {
			remainingMs -= delay;
			if (remainingMs > 0) {
				schedule();
				return;
			}
			controller.abort(new DOMException("alint Stop Gate timed out.", "TimeoutError"));
		}, delay);
	};
	schedule();
	return {
		dispose: () => clearTimeout(timer),
		signal: controller.signal
	};
}
function incompatibleAlintError() {
	return /* @__PURE__ */ new Error("The resolved alint CLI does not support the Stop Gate protocol. Update @alint-js/cli before using this plugin.");
}
function isEnvelopeRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value;
	return record.schemaVersion === 2 && typeof record.errorCount === "number" && Number.isInteger(record.errorCount) && record.errorCount >= 0 && typeof record.warningCount === "number" && Number.isInteger(record.warningCount) && record.warningCount >= 0;
}
function packageManagerTimeoutError(command) {
	const subject = command.source === "package-manager" ? `${command.executable} package-manager exec` : `${command.executable} startup`;
	return /* @__PURE__ */ new Error(`${subject} exceeded the 1 minute startup limit. Run the Stop Gate config command manually and fix the local installation before retrying.`);
}
function truncateStderr(stderr) {
	const bytes = Buffer$1.from(stderr, "utf8");
	if (bytes.length <= stderrExcerptLimitBytes) return stderr;
	const markerBytes = Buffer$1.byteLength(stderrTruncationMarker);
	const excerptBytes = stderrExcerptLimitBytes - markerBytes;
	const headBytes = Math.ceil(excerptBytes / 2);
	const tailBytes = Math.floor(excerptBytes / 2);
	let headEnd = headBytes;
	let tailStart = bytes.length - tailBytes;
	while (headEnd > 0 && ((bytes[headEnd] ?? 0) & 192) === 128) headEnd -= 1;
	while (tailStart < bytes.length && ((bytes[tailStart] ?? 0) & 192) === 128) tailStart += 1;
	return `${bytes.toString("utf8", 0, headEnd)}${stderrTruncationMarker}${bytes.toString("utf8", tailStart)}`;
}
// src/resolve-command.ts
async function resolveCommands(gitRoot) {
	const commands = [];
	const local = join(gitRoot, "node_modules", ".bin", process$1.platform === "win32" ? "alint.cmd" : "alint");
	if (await canAccess(local, process$1.platform === "win32" ? constants.F_OK : constants.X_OK)) commands.push({
		args: [],
		executable: local,
		source: "local"
	});
	const packageManager = await detectPackageManager(gitRoot);
	if (packageManager !== void 0) commands.push(packageManager === "npm" ? {
		args: [
			"exec",
			"--offline",
			"--yes=false",
			"--",
			"alint"
		],
		executable: "npm",
		source: "package-manager"
	} : packageManager === "bun" ? {
		args: [
			"x",
			"--no-install",
			"alint"
		],
		executable: "bun",
		source: "package-manager"
	} : {
		args: ["exec", "alint"],
		executable: packageManager,
		source: "package-manager"
	});
	commands.push({
		args: [],
		executable: "alint",
		source: "path"
	});
	return commands;
}
async function canAccess(path, mode) {
	try {
		await access(path, mode);
		return true;
	} catch (error) {
		if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "EACCES")) return false;
		throw error;
	}
}
async function detectPackageManager(gitRoot) {
	const packageManager = await readPackageManagerField(gitRoot);
	if (packageManager !== void 0) return packageManager;
	for (const [lockfile, manager] of [
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["bun.lock", "bun"],
		["bun.lockb", "bun"],
		["package-lock.json", "npm"],
		["npm-shrinkwrap.json", "npm"]
	]) if (await canAccess(join(gitRoot, lockfile), constants.F_OK)) return manager;
}
async function readPackageManagerField(gitRoot) {
	try {
		const packageJson = JSON.parse(await readFile(join(gitRoot, "package.json"), "utf8"));
		if (typeof packageJson.packageManager !== "string") return;
		const name = packageJson.packageManager.split("@", 1)[0];
		return name === "bun" || name === "npm" || name === "pnpm" || name === "yarn" ? name : void 0;
	} catch (error) {
		if (isNodeErrorCode(error, "ENOENT")) return;
		throw error;
	}
}
// src/runner.ts
async function resolveAlintStopGate(gitRoot) {
	const commands = await resolveCommands(gitRoot);
	const startupDeadline = Date.now() + startupTimeoutMs;
	for (const command of commands) {
		const config = await probeStopGateConfig(command, gitRoot, startupDeadline);
		if (config === void 0) continue;
		return {
			enabled: config.enabled,
			run: (sessionId) => executeStopGate(command, gitRoot, sessionId, config.timeoutMs),
			target: config.target
		};
	}
	throw new Error(["Could not find an alint CLI that supports `integrations stop-gate`.", "Ask the user for approval before installing or updating @alint-js/cli in this repository."].join(" "));
}
// src/state.ts
const retentionMs = 31536e6;
const stateSchemaVersion = 2;
function createStateStore(pluginDataDirectory, now = () => /* @__PURE__ */ new Date()) {
	const stopGateDirectory = join(pluginDataDirectory, "stop-gate");
	const sessionsDirectory = join(stopGateDirectory, `sessions-v${stateSchemaVersion}`);
	return {
		async load(sessionId) {
			const statePath = getStatePath(sessionsDirectory, sessionId);
			try {
				return parseState(JSON.parse(await readFile(statePath, "utf8")));
			} catch (error) {
				if (isNodeErrorCode(error, "ENOENT")) return emptyState();
				throw error;
			}
		},
		async save(sessionId, state) {
			const statePath = getStatePath(sessionsDirectory, sessionId);
			const tempPath = join(sessionsDirectory, `${sessionId}-${randomUUID()}.tmp`);
			await mkdir(sessionsDirectory, { recursive: true });
			await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			await rename(tempPath, statePath);
			await pruneExpiredStateDirectories(stopGateDirectory, now().getTime());
		}
	};
}
function emptyState() {
	return {
		lintRounds: 0,
		runtimeFailures: 0,
		schemaVersion: stateSchemaVersion,
		updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
	};
}
function getStatePath(directory, sessionId) {
	if (sessionId === "." || sessionId === ".." || !/^[\w.-]+$/u.test(sessionId)) throw new Error("Invalid Stop hook session id.");
	return join(directory, `${sessionId}.json`);
}
function isFindingSummary(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const finding = value;
	return Number.isInteger(finding.errorCount) && (finding.errorCount ?? -1) >= 0 && typeof finding.findingsHash === "string" && /^[a-f0-9]{64}$/u.test(finding.findingsHash) && typeof finding.reportPath === "string" && (finding.status === "errors" || finding.status === "warnings") && Number.isInteger(finding.warningCount) && (finding.warningCount ?? -1) >= 0;
}
function parseState(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid Stop Gate session state.");
	const state = value;
	if (state.schemaVersion !== 2 || !Number.isInteger(state.lintRounds) || (state.lintRounds ?? -1) < 0 || !Number.isInteger(state.runtimeFailures) || (state.runtimeFailures ?? -1) < 0 || typeof state.updatedAt !== "string") throw new TypeError("Invalid Stop Gate session state.");
	if (state.lastFindings !== void 0 && !isFindingSummary(state.lastFindings)) throw new TypeError("Invalid Stop Gate session state.");
	return state;
}
async function pruneExpiredStateDirectories(directory, nowMs) {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^sessions(?:-v\d+)?$/u.test(entry.name)) continue;
		await pruneExpiredStates(join(directory, entry.name), nowMs);
	}
}
async function pruneExpiredStates(directory, nowMs) {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(directory, entry.name);
		if (nowMs - (await stat(path)).mtimeMs > retentionMs) await rm(path, { force: true });
	}
}
// src/stop-gate.ts
function emit(decision) {
	if (Object.keys(decision).length > 0) writeSync(process$1.stdout.fd, `${JSON.stringify(decision)}\n`);
}
function inactiveEnvelope() {
	return {
		errorCount: 0,
		schemaVersion: 2,
		status: "inactive",
		warningCount: 0
	};
}
function readHookInput() {
	const input = readFileSync(0, "utf8").trim();
	return input.length === 0 ? {} : JSON.parse(input);
}
function requiredString(value, message) {
	if (value === void 0 || value.length === 0) throw new Error(message);
	return value;
}
function runtimeErrorEnvelope(message) {
	return {
		errorCount: 0,
		message,
		schemaVersion: 2,
		status: "runtime-error",
		warningCount: 0
	};
}
let parsedInput;
try {
	parsedInput = readHookInput();
} catch (error) {
	reportFatalFailure("Could not read Codex hook input", error);
}
if (parsedInput !== void 0) run(parsedInput).catch((error) => {
	try {
		const message = runtimeErrorMessage({ message: errorMessageFrom(error) ?? "unknown error" });
		emit(parsedInput?.stop_hook_active ? { systemMessage: message } : {
			decision: "block",
			reason: message
		});
	} catch (emitError) {
		reportFatalFailure("Could not return its hook failure decision", emitError);
	}
});
async function run(input) {
	const sessionId = requiredString(input.session_id, "Stop hook input did not include session_id.");
	const store = createStateStore(requiredString(process$1.env.CLAUDE_PLUGIN_DATA, "Codex did not provide CLAUDE_PLUGIN_DATA to the alint plugin."));
	const state = await store.load(sessionId);
	let result;
	try {
		result = await runForInput(input, sessionId, state);
	} catch (error) {
		result = { envelope: runtimeErrorEnvelope(errorMessageFrom(error) ?? "unknown error") };
	}
	if (result.decision !== void 0) {
		emit(result.decision);
		return;
	}
	const applied = applyResult(state, result.envelope ?? runtimeErrorEnvelope("unknown error"));
	await store.save(sessionId, applied.state);
	emit(applied.decision);
}
async function runForInput(input, sessionId, state) {
	const gitRoot = await findGitRoot(input.cwd ?? process$1.cwd());
	if (gitRoot === void 0 || !await hasProjectConfig(gitRoot)) return { envelope: inactiveEnvelope() };
	const stopGate = await resolveAlintStopGate(gitRoot);
	if (!stopGate.enabled) return { envelope: inactiveEnvelope() };
	if (stopGate.target === "dirty-files" && await isHeadDetached(gitRoot)) return { decision: { systemMessage: "alint-plugin: Stop Gate skipped because Git HEAD is detached. You may need to let the user know that. Run `alint --dirty` manually if this checkout should be reviewed." } };
	if (state.lintRounds >= 9) return { decision: lintLimitDecision(state) };
	return { envelope: await stopGate.run(sessionId) };
}
export {};
