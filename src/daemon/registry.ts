import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { configPath } from "../shared/paths.ts";

export const PROJECT_CONFIG_FILE = ".lsp-mcp.json";

export interface FormatterDef {
  /** Command to run; any "{file}" argument is replaced with the absolute file path. */
  cmd: string[];
  languageIds: string[];
  /** "stdio" (default): pipe current content to stdin, read formatted result from stdout.
   *  "inplace": the command mutates the file itself (e.g. `prettier --write {file}`) — stdout is ignored. */
  mode?: "stdio" | "inplace";
}

export interface ProjectConfig {
  /** Server IDs to auto-start for any file whose languageId matches that server's languageIds. */
  servers?: string[];
  /** External formatters to run as part of lsp_autofix. */
  formatters?: FormatterDef[];
  /** When formatters run relative to LSP code-action fixes during autofix. Default "after". */
  formatOrder?: "before" | "after";
  /** Extra env vars per server, merged on top of the server's own defaults when auto-starting.
   *  Useful when a project's eslint/tsserver config needs a loader (e.g. NODE_OPTIONS for local
   *  TS-authored eslint plugins) that the LSP process wouldn't otherwise inherit. */
  serverEnv?: Record<string, Record<string, string>>;
}

/** Walk up from startPath looking for a `.lsp-mcp.json`. Returns its directory + parsed config. */
export function findProjectConfig(startPath: string): { root: string; config: ProjectConfig } | null {
  let dir = existsSync(startPath) && statSync(startPath).isDirectory() ? startPath : dirname(startPath);
  while (true) {
    const cfgFile = join(dir, PROJECT_CONFIG_FILE);
    if (existsSync(cfgFile)) {
      try {
        const config = JSON.parse(readFileSync(cfgFile, "utf8")) as ProjectConfig;
        return { root: dir, config };
      } catch {
        // malformed config — ignore and keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findGitRoot(startPath: string): string | null {
  let dir = existsSync(startPath) && statSync(startPath).isDirectory() ? startPath : dirname(startPath);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the project root without requiring a serverId: prefers the nearest `.lsp-mcp.json`,
 * falls back to the nearest `.git`, falls back to a server's own root markers if given.
 */
export function resolveRoot(startPath: string, serverId?: string): string {
  const projectConfig = findProjectConfig(startPath);
  if (projectConfig) return projectConfig.root;
  const gitRoot = findGitRoot(startPath);
  if (gitRoot) return gitRoot;
  return resolveProjectRoot(startPath, serverId ?? "tsgo");
}

export interface ServerDef {
  cmd: string[];
  roots: string[];
  languageIds: string[];
  /** Sent via workspace/didChangeConfiguration after initialized. */
  settings?: unknown;
  /** Sent in the initialize request as initializationOptions. */
  initializationOptions?: unknown;
  /** Extra env vars merged on top of process.env when spawning the LSP. */
  env?: Record<string, string>;
  /** Per-server override for the stall-kill threshold (see LspMcpConfig.stallTimeoutMs). */
  stallTimeoutMs?: number;
}

const BUILTIN: Record<string, ServerDef> = {
  tsgo: {
    cmd: ["tsgo", "--lsp", "--stdio"],
    roots: ["tsconfig.json", "jsconfig.json", "package.json"],
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  },
  tsserver: {
    cmd: ["typescript-language-server", "--stdio"],
    roots: ["tsconfig.json", "jsconfig.json", "package.json"],
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    // see https://github.com/typescript-language-server/typescript-language-server/blob/master/docs/configuration.md#initializationoptions
    initializationOptions: {
      hostInfo: "lsp-mcp",
      maxTsServerMemory: 8192,
      preferences: {
        includeInlayParameterNameHints: "none",
        includeInlayPropertyDeclarationTypeHints: false,
        includeInlayFunctionLikeReturnTypeHints: false,
        importModuleSpecifierPreference: "shortest",
      },
      tsserver: {
        // syntax-only server stays warm for fast outline/hover; semantic spawns lazily
        useSyntaxServer: "auto",
        logVerbosity: "off",
      },
    },
  },
  eslint: {
    cmd: ["vscode-eslint-language-server", "--stdio"],
    roots: [".eslintrc", ".eslintrc.js", ".eslintrc.json", "eslint.config.js", "eslint.config.ts", "package.json"],
    languageIds: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    // Full schema required — the server crashes internally (path.resolve(undefined) style errors,
    // both on pull AND push diagnostics) if expected keys are missing. See microsoft/vscode-eslint#2008.
    settings: {
      validate: "on",
      packageManager: null,
      useESLintClass: false,
      experimental: {},
      codeActionOnSave: { enable: false, mode: "all" },
      format: true,
      quiet: false,
      onIgnoredFiles: "off",
      rulesCustomizations: [],
      run: "onType",
      problems: { shortenToSingleLine: false },
      nodePath: "",
      workingDirectory: { mode: "auto" },
      workspaceFolder: { uri: "" },
      codeAction: {
        disableRuleComment: { enable: true, location: "separateLine" },
        showDocumentation: { enable: true },
      },
    },
  },
  gopls: {
    cmd: ["gopls"],
    roots: ["go.mod", ".git"],
    languageIds: ["go"],
  },
};

export interface LspMcpConfig {
  diagnosticsTimeoutMs?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  socketDir?: string;
  servers?: Record<string, Partial<ServerDef>>;
  /**
   * How long a language server may go without sending ANY message before the supervisor
   * considers it stalled and kills + restarts it. Restart is automatic (crash backoff applies).
   * A server is only killed while it is expected to be doing work: initializing, has an
   * unanswered request, or has open documents whose diagnostics were never delivered.
   * Idle-but-healthy servers are never killed. Default 180000 (3 min).
   */
  stallTimeoutMs?: number;
}

let _config: LspMcpConfig | null = null;

export function loadConfig(): LspMcpConfig {
  if (_config) return _config;
  try {
    const cfgFile = configPath();
    if (existsSync(cfgFile)) {
      // Note: Bun.file().text is an async METHOD — must use readFileSync here,
      // otherwise JSON.parse(fn) throws and the whole config silently becomes {}.
      _config = JSON.parse(readFileSync(cfgFile, "utf8")) as LspMcpConfig;
    }
  } catch {
    // ignore
  }
  _config ??= {};
  return _config;
}

export function getServerDef(serverId: string): ServerDef {
  const cfg = loadConfig();
  const base = BUILTIN[serverId];
  const override = cfg.servers?.[serverId] ?? {};
  if (!base && !override.cmd) {
    throw new Error(`Unknown server: ${serverId}. Available: ${Object.keys(BUILTIN).join(", ")}`);
  }
  return {
    cmd: override.cmd ?? base?.cmd ?? [],
    roots: override.roots ?? base?.roots ?? [".git"],
    languageIds: override.languageIds ?? base?.languageIds ?? [],
    settings: override.settings ?? base?.settings,
    initializationOptions: override.initializationOptions ?? base?.initializationOptions,
    env: { ...(base?.env ?? {}), ...(override.env ?? {}) },
    stallTimeoutMs: override.stallTimeoutMs ?? base?.stallTimeoutMs,
  };
}

export function listServers(): string[] {
  const cfg = loadConfig();
  return [...new Set([...Object.keys(BUILTIN), ...Object.keys(cfg.servers ?? {})])];
}

export function resolveProjectRoot(startPath: string, serverId: string): string {
  const def = getServerDef(serverId);
  let dir = existsSync(startPath) && !startPath.includes(".") ? startPath : dirname(startPath);
  // Walk up until we find a root marker
  while (true) {
    for (const marker of def.roots) {
      // marker may be a glob pattern like ".eslintrc*" — handle simple prefix match
      const base = marker.replace(/\*.*$/, "");
      const entries = (() => {
        try {
          return readdirSync(dir) as string[];
        } catch {
          return [] as string[];
        }
      })();
      if (entries.some((e: string) => e === marker || (marker.includes("*") && e.startsWith(base)))) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return startPath; // hit fs root, give up
    dir = parent;
  }
}

export function languageIdForFile(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    mjs: "javascript",
    cjs: "javascript",
    go: "go",
    py: "python",
    rs: "rust",
  };
  return map[ext] ?? ext;
}
