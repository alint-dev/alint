#!/usr/bin/env node
import process from "node:process";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	writeSync(process.stderr.fd, `${failure}\n${guidance}\n`);
	process.exitCode = 1;
}
function writeFatalDiagnostic(context, detail) {
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	const fileName = `${timestamp.replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}.log`;
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
	const content = Buffer.from(`timestamp: ${timestamp}\ncontext: ${context}\ndetail: ${detail}\n`);
	if (content.byteLength <= budgetBytes) return content;
	const marker = Buffer.from(truncationMarker);
	return Buffer.concat([content.subarray(0, budgetBytes - marker.byteLength), marker]);
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
// src/stop-gate-launcher.ts
const stderrExcerptLimitBytes = 4096;
const stderrTruncationMarker = "\n... child stderr truncated ...\n";
const childFatalPrefix = "alint-plugin: Stop Gate hook runtime error.";
run().catch((error) => {
	reportFatalFailure("Stop Gate launcher failed before starting its child process", error);
});
function createStderrExcerpt() {
	const markerBytes = Buffer.byteLength(stderrTruncationMarker);
	const excerptBytes = stderrExcerptLimitBytes - markerBytes;
	const headLimit = Math.ceil(excerptBytes / 2);
	const tailLimit = Math.floor(excerptBytes / 2);
	let head = Buffer.alloc(0);
	let tail = Buffer.alloc(0);
	let totalBytes = 0;
	return {
		append(chunk) {
			totalBytes += chunk.byteLength;
			let remaining = chunk;
			if (head.byteLength < headLimit) {
				const headBytes = Math.min(headLimit - head.byteLength, remaining.byteLength);
				head = Buffer.concat([head, remaining.subarray(0, headBytes)]);
				remaining = remaining.subarray(headBytes);
			}
			if (remaining.byteLength > 0) {
				const nextTail = Buffer.concat([tail, remaining]);
				tail = nextTail.subarray(Math.max(0, nextTail.byteLength - tailLimit));
			}
		},
		text() {
			if (totalBytes <= stderrExcerptLimitBytes) return Buffer.concat([head, tail]).toString("utf8");
			const headText = head.toString("utf8").replace(/\uFFFD+$/u, "");
			const tailText = tail.toString("utf8").replace(/^\uFFFD+/u, "");
			return `${headText}${stderrTruncationMarker}${tailText}`;
		}
	};
}
async function run() {
	const hook = fileURLToPath(new URL("./stop-gate.mjs", import.meta.url));
	const child = spawn(process.execPath, [hook], {
		cwd: process.cwd(),
		env: process.env,
		stdio: [
			"inherit",
			"inherit",
			"pipe"
		]
	});
	const stderr = createStderrExcerpt();
	let forwardingError;
	let spawnError;
	child.stderr.on("data", (chunk) => {
		stderr.append(chunk);
		try {
			writeSync(process.stderr.fd, chunk);
		} catch (error) {
			forwardingError ??= errorMessageFrom(error) ?? "unknown error";
		}
	});
	const result = await new Promise((resolve) => {
		child.once("error", (error) => {
			spawnError = errorMessageFrom(error) ?? "unknown error";
		});
		child.once("close", (code, signal) => resolve({
			code,
			signal
		}));
	});
	if (result.code === 0) return;
	process.exitCode = 1;
	const stderrText = stderr.text().trim();
	if (stderrText.startsWith(childFatalPrefix)) return;
	const details = [
		`exit code: ${result.code ?? "none"}`,
		`signal: ${result.signal ?? "none"}`,
		...spawnError === void 0 ? [] : [`spawn error: ${spawnError}`],
		...forwardingError === void 0 ? [] : [`stderr forwarding error: ${forwardingError}`],
		`stderr:\n${stderrText.length === 0 ? "(none)" : stderrText}`
	];
	reportFatalFailure("Stop Gate child process exited before returning a hook decision", new Error(details.join("\n")));
}
export {};
