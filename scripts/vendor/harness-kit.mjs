#!/usr/bin/env bun
// @bun

// src/cli.mjs
import fs12 from "fs";
import path8 from "path";

// src/discovery.mjs
import fs5 from "fs";

// src/fs.mjs
import fs from "fs";
import path from "path";
import crypto from "crypto";
var slash = (value) => value.replaceAll("\\", "/");
var hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function stable(value) {
  if (Array.isArray(value))
    return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
var digest = (value) => hash(stable(value));
var json = (value) => `${JSON.stringify(value, null, 2)}
`;
function relativePath(value, { glob = false } = {}) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\x00") || value.includes(":") || path.isAbsolute(value))
    throw new Error(`Invalid relative path: ${value}`);
  if (value.split("/").some((p) => p === ".." || p !== "." && /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || !glob && /[*?\[\]{}]/.test(p)) || /[\x00-\x1f]/.test(value))
    throw new Error(`Unsafe relative path: ${value}`);
  return path.posix.normalize(value).replace(/\/$/, "") || ".";
}
function safePath(root, relative, { allowMissing = true } = {}) {
  relative = relativePath(relative);
  root = fs.realpathSync(root);
  const target = path.resolve(root, relative);
  const fromRoot = path.relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot))
    throw new Error(`Path escapes root: ${relative}`);
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new Error(`Symbolic link not allowed: ${relative}`);
    } catch (error) {
      if (!(allowMissing && error.code === "ENOENT"))
        throw error;
    }
  }
  if (!allowMissing && !fs.existsSync(target))
    throw new Error(`Missing path: ${relative}`);
  return target;
}
function readJson(root, name) {
  try {
    return JSON.parse(fs.readFileSync(safePath(root, name, { allowMissing: false }), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${name}: ${error.message}`);
  }
}
function fileHash(root, name) {
  const target = safePath(root, name);
  return fs.existsSync(target) ? hash(fs.readFileSync(target)) : null;
}
function atomicWrite(root, name, content) {
  const target = safePath(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: "wx" });
    fs.renameSync(tmp, target);
  } finally {
    if (fs.existsSync(tmp))
      fs.unlinkSync(tmp);
  }
}
var defaultIgnore = [".git", "node_modules", ".harness", "artifacts", "coverage", "dist", "build"];
function walk(root, { ignore = defaultIgnore } = {}) {
  const result = [];
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignore.includes(entry.name))
        continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        result.push({ path: name, type: "symlink" });
      else if (entry.isDirectory())
        visit(path.join(dir, entry.name), name);
      else if (entry.isFile())
        result.push({ path: name, type: "file" });
      else
        result.push({ path: name, type: "unsupported" });
    }
  }
  visit(fs.realpathSync(root), "");
  return result;
}
function matches(name, pattern) {
  pattern = relativePath(pattern, { glob: true });
  let expr = "";
  for (let i = 0;i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        expr += "(?:.*/)?";
      } else
        expr += ".*";
    } else if (c === "*")
      expr += "[^/]*";
    else if (c === "?")
      expr += "[^/]";
    else
      expr += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expr}$`, "i").test(slash(name));
}
var under = (name, root) => root === "." || name.toLowerCase() === root.toLowerCase() || name.toLowerCase().startsWith(root.toLowerCase() + "/");

// src/config.mjs
import fs2 from "fs";
var CONFIG = "harness.config.json";
var object = (v, label) => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error(`${label} must be an object`);
};
var keys = (v, allowed, label) => {
  object(v, label);
  for (const k of Object.keys(v))
    if (!allowed.includes(k))
      throw new Error(`Unknown ${label} field: ${k}`);
};
var strings = (v, label) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x))
    throw new Error(`${label} must be a string array`);
};
var bool = (v, label) => {
  if (typeof v !== "boolean")
    throw new Error(`${label} must be boolean`);
};
var enumValue = (v, choices, label) => {
  if (!choices.includes(v))
    throw new Error(`Invalid ${label}: ${v}`);
};
var id = (v) => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(v))
    throw new Error(`Invalid id: ${v}`);
};
function array(v, label) {
  if (!Array.isArray(v))
    throw new Error(`${label} must be an array`);
}
function paths(v, label, glob = false) {
  strings(v, label);
  for (let i = 0;i < v.length; i++)
    v[i] = relativePath(v[i], { glob });
}
function documents(v) {
  keys(v, ["defaultAudience", "publicRoots", "internalRoots", "publicPatterns", "internalPatterns"], "documents");
  if (v.defaultAudience !== undefined && v.defaultAudience !== "internal")
    throw new Error("documents.defaultAudience must be internal");
  for (const k of ["publicRoots", "internalRoots", "publicPatterns", "internalPatterns"])
    if (v[k] !== undefined)
      paths(v[k], `documents.${k}`, k.endsWith("Patterns"));
}
function tests(v) {
  keys(v, ["include", "exclude", "artifacts", "requireConfiguredTask"], "tests");
  for (const k of ["include", "exclude"])
    if (v[k] !== undefined)
      paths(v[k], `tests.${k}`, true);
  if (v.artifacts !== undefined)
    paths(v.artifacts, "tests.artifacts");
  if (v.requireConfiguredTask !== undefined)
    bool(v.requireConfiguredTask, "requireConfiguredTask");
}
function defaults() {
  return {
    schemaVersion: 1,
    repository: { visibility: "unknown" },
    workspaces: [{ id: "root", root: "." }],
    documents: { defaultAudience: "internal", publicRoots: ["docs/public"], internalRoots: ["docs/prd", "docs/decision", "docs/verification", ".harness"], publicPatterns: ["README.md"], internalPatterns: ["docs/structure.md", "docs/agent_guide.md", "**/MEMORY.md", "**/memory/**", "**/memories/**", "**/decision/**", "**/decisions/**"] },
    tests: { include: [], exclude: [], artifacts: ["artifacts", "coverage"], requireConfiguredTask: false },
    tasks: [],
    publicationTargets: [],
    rules: {},
    baseline: []
  };
}
function validateConfig(value, root) {
  keys(value, ["schemaVersion", "repository", "workspaces", "documents", "tests", "tasks", "publicationTargets", "rules", "baseline"], "config");
  if (value.schemaVersion !== 1)
    throw new Error("Unsupported schemaVersion (expected 1)");
  const c = { ...defaults(), ...structuredClone(value) };
  documents(c.documents);
  tests(c.tests);
  c.documents = { ...defaults().documents, ...c.documents };
  c.tests = { ...defaults().tests, ...c.tests };
  keys(c.repository, ["visibility"], "repository");
  enumValue(c.repository.visibility, ["private", "public", "unknown"], "repository.visibility");
  documents(c.documents);
  tests(c.tests);
  array(c.workspaces, "workspaces");
  if (!c.workspaces.length)
    throw new Error("At least one workspace is required");
  const ids = new Set, roots = new Set;
  for (const w of c.workspaces) {
    keys(w, ["id", "root", "documents", "tests"], "workspace");
    id(w.id);
    w.root = relativePath(w.root);
    if (ids.has(w.id) || roots.has(w.root.toLowerCase()))
      throw new Error(`Duplicate workspace: ${w.id}`);
    ids.add(w.id);
    roots.add(w.root.toLowerCase());
    if (root && !fs2.statSync(safePath(root, w.root, { allowMissing: false })).isDirectory())
      throw new Error(`Workspace is not a directory: ${w.root}`);
    if (w.documents)
      documents(w.documents);
    if (w.tests)
      tests(w.tests);
  }
  array(c.tasks, "tasks");
  const taskIds = new Set;
  for (const t of c.tasks) {
    keys(t, ["id", "workspace", "argv", "cwd", "dependsOn", "kind", "required", "enabled", "timeoutMs", "covers"], "task");
    id(t.id);
    if (taskIds.has(t.id))
      throw new Error(`Duplicate task: ${t.id}`);
    taskIds.add(t.id);
    t.workspace ??= c.workspaces[0].id;
    if (!ids.has(t.workspace))
      throw new Error(`Unknown workspace: ${t.workspace}`);
    strings(t.argv, "task.argv");
    if (!t.argv.length || t.argv.some((x) => x.includes("\x00")))
      throw new Error("task.argv must contain a command");
    t.cwd ??= ".";
    t.cwd = relativePath(t.cwd);
    t.dependsOn ??= [];
    strings(t.dependsOn, "dependsOn");
    t.kind ??= "test";
    enumValue(t.kind, ["test", "lint", "typecheck", "build", "custom"], "task.kind");
    t.required ??= true;
    t.enabled ??= true;
    bool(t.required, "required");
    bool(t.enabled, "enabled");
    t.timeoutMs ??= 60000;
    if (!Number.isSafeInteger(t.timeoutMs) || t.timeoutMs < 1 || t.timeoutMs > 86400000)
      throw new Error("Invalid task.timeoutMs");
    t.covers ??= [t.workspace];
    strings(t.covers, "covers");
    for (const w of t.covers)
      if (!ids.has(w))
        throw new Error(`Unknown covers workspace: ${w}`);
  }
  for (const t of c.tasks)
    for (const d of t.dependsOn)
      if (!taskIds.has(d))
        throw new Error(`Unknown dependency: ${d}`);
  array(c.publicationTargets, "publicationTargets");
  const targets = new Set;
  for (const p of c.publicationTargets) {
    keys(p, ["id", "manifest"], "publicationTarget");
    id(p.id);
    relativePath(p.manifest);
    if (targets.has(p.id))
      throw new Error(`Duplicate target: ${p.id}`);
    targets.add(p.id);
  }
  keys(c.rules, ["tests.layout", "tests.configured", "tests.artifacts", "documents.links", "tasks.graph"], "rules");
  for (const [k, v] of Object.entries(c.rules))
    enumValue(v, ["error", "warning", "off"], k);
  strings(c.baseline, "baseline");
  return c;
}
var loadConfig = (root) => validateConfig(readJson(root, CONFIG), root);
function effectiveTests(c, w) {
  return { ...defaults().tests, ...c.tests, ...w.tests };
}

// src/adapters/javascript.mjs
import fs3 from "fs";
import path2 from "path";
function discoverJavascript(root, files) {
  const facts = [], workspaces = [], tasks = [], questions = [], packages = [];
  for (const f of files.filter((f2) => f2 === "package.json" || f2.endsWith("/package.json"))) {
    let pkg;
    try {
      pkg = JSON.parse(fs3.readFileSync(safePath(root, f), "utf8"));
    } catch {
      questions.push({ id: `invalid:${f}`, message: `Repair invalid JSON: ${f}`, type: "manual" });
      continue;
    }
    packages.push({ file: f, root: path2.posix.dirname(f), pkg });
  }
  const rootPackage = packages.find((p) => p.root === ".");
  let patterns = rootPackage?.pkg.workspaces?.packages ?? rootPackage?.pkg.workspaces ?? [];
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) {
    questions.push({ id: "workspace-patterns", message: "Provide explicit workspaces; unsupported workspace declaration", type: "manual" });
    patterns = [];
  }
  if (files.includes("pnpm-workspace.yaml")) {
    const yaml = fs3.readFileSync(safePath(root, "pnpm-workspace.yaml"), "utf8");
    const section = /^packages:\s*(?:#.*)?\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(yaml);
    if (section)
      patterns = [...section[1].matchAll(/^\s+-\s+['"]?([^'"\r\n#]+)['"]?\s*(?:#.*)?$/gm)].map((m) => m[1].trim());
    else
      questions.push({ id: "workspace-patterns", message: "Provide explicit workspaces; pnpm packages declaration could not be parsed", type: "manual" });
  }
  for (const p of packages) {
    const wId = p.root === "." ? "root" : p.root.replace(/[^a-zA-Z0-9._-]/g, "-");
    const declared = p.root === "." || patterns.some((g) => !g.startsWith("!") && matches(p.root, g)) && !patterns.some((g) => g.startsWith("!") && matches(p.root, g.slice(1)));
    facts.push({ source: p.file, capability: "javascript-package", declaredWorkspace: declared, testFrameworks: Object.keys({ ...p.pkg.dependencies, ...p.pkg.devDependencies }).filter((k) => ["vitest", "jest", "@playwright/test"].includes(k)) });
    if (!declared && patterns.length) {
      questions.push({ id: `workspace:${wId}`, message: `${p.root} is not declared in root workspaces; include explicitly if needed`, type: "manual" });
      continue;
    }
    const managerHint = p.pkg.packageManager ?? rootPackage?.pkg.packageManager;
    const localLocks = ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock"].filter((lock) => files.includes(p.root === "." ? lock : `${p.root}/${lock}`));
    const rootLocks = ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock"].filter((lock) => files.includes(lock));
    const locks = localLocks.length ? localLocks : rootLocks;
    const inferred = [...new Set(locks.map((f) => f.startsWith("pnpm") ? "pnpm" : f.startsWith("bun") ? "bun" : f.startsWith("yarn") ? "yarn" : "npm"))];
    let manager = typeof managerHint === "string" ? managerHint.split("@")[0] : inferred.length === 1 ? inferred[0] : null;
    if (inferred.length > 1) {
      manager = null;
      questions.push({ id: `manager:${wId}`, message: `Multiple package managers at ${p.root}; choose explicitly`, type: "manager", workspace: wId });
    } else if (!manager && Object.keys(p.pkg.scripts ?? {}).length)
      questions.push({ id: `manager:${wId}`, message: `Choose package manager for ${p.root}`, type: "manager", workspace: wId });
    workspaces.push({ id: wId, root: p.root });
    const scripts = p.pkg.scripts ?? {};
    if (manager)
      for (const [script, kind] of [["test", "test"], ["lint", "lint"], ["typecheck", "typecheck"], ["harness-lint", "lint"]]) {
        if (typeof scripts[script] !== "string" || /no test specified/i.test(scripts[script]))
          continue;
        if (/--recursive|(?:^|\s)-r(?:\s|$)|--workspaces|turbo\s|nx\s|--filter/.test(scripts[script])) {
          questions.push({ id: `aggregate:${wId}:${script}`, message: `${p.file} ${script} appears to aggregate other workspaces; declare covers to avoid duplicate execution`, type: "manual" });
          continue;
        }
        if (/harness(?:-kit)?(?:\.mjs)?\s+(verify|lint)/.test(scripts[script]))
          continue;
        tasks.push({ id: `${wId}:${script}`, workspace: wId, kind, argv: [manager, "run", script] });
      }
  }
  return { facts, workspaces, tasks, questions };
}

// src/adapters/go.mjs
import fs4 from "fs";
import path3 from "path";
function discoverGo(root, files) {
  const facts = [], workspaces = [], tasks = [], questions = [];
  for (const file of files.filter((f) => f === "go.mod" || f.endsWith("/go.mod"))) {
    const directory = path3.posix.dirname(file), id2 = directory === "." ? "root" : directory.replace(/[^a-zA-Z0-9._-]/g, "-");
    facts.push({ source: file, capability: "go-module" });
    workspaces.push({ id: id2, root: directory, tests: { include: ["**/*_test.go"] } });
    tasks.push({ id: `${id2}:go-test`, workspace: id2, kind: "test", argv: ["go", "test", "./..."] });
  }
  for (const file of files.filter((f) => f === "go.work" || f.endsWith("/go.work"))) {
    const content = fs4.readFileSync(safePath(root, file), "utf8");
    facts.push({ source: file, capability: "go-workspace" });
    const declarations = [...content.matchAll(/(?:^use\s+([^\r\n(]+)|^use\s*\(([\s\S]*?)\))/gm)].flatMap((m) => (m[1] ?? m[2]).split(/\r?\n/)).map((s) => s.replace(/\/\/.*$/, "").trim().replace(/^"|"$/g, "")).filter(Boolean);
    for (const dir of declarations) {
      const module = path3.posix.normalize(path3.posix.join(path3.posix.dirname(file), dir, "go.mod"));
      if (!files.includes(module))
        questions.push({ id: `module:${module}`, message: `Missing or external go.work module: ${module}`, type: "manual" });
    }
  }
  return { facts, workspaces, tasks, questions };
}

// src/discovery.mjs
function inspect(root) {
  const entries = walk(root), files = entries.filter((e) => e.type === "file").map((e) => e.path);
  if (fs5.existsSync(safePath(root, CONFIG))) {
    const config2 = loadConfig(root);
    return { facts: [{ source: CONFIG, capability: "explicit-config" }], questions: config2.repository.visibility === "unknown" ? [visibilityQuestion] : [], suggestedConfig: config2, files };
  }
  const config = defaults(), facts = [], questions = [visibilityQuestion], ws = new Map;
  for (const adapter of [discoverJavascript, discoverGo]) {
    const found = adapter(root, files);
    facts.push(...found.facts);
    questions.push(...found.questions);
    config.tasks.push(...found.tasks);
    for (const w of found.workspaces) {
      const previous = ws.get(w.root);
      if (!previous)
        ws.set(w.root, w);
      else {
        const includes = [previous.tests?.include, w.tests?.include];
        const include = includes.every((patterns) => patterns?.length) ? [...new Set(includes.flat())] : [];
        ws.set(w.root, { ...previous, tests: { ...previous.tests, ...w.tests, include } });
      }
    }
  }
  config.workspaces = ws.size ? [...ws.values()] : defaults().workspaces;
  for (const w of config.workspaces)
    if (!config.tasks.some((t) => t.workspace === w.id && t.kind === "test"))
      questions.push({ id: `tests:${w.id}`, type: "test-command", workspace: w.id, message: `Provide test argv for ${w.root}, or explicitly leave tests unconfigured` });
  for (const e of entries.filter((e2) => e2.type !== "file"))
    facts.push({ source: e.path, capability: "unscanned-path", reason: e.type });
  if (files.includes("docs/agent_guide.md") && files.includes("scripts/verify.sh"))
    facts.push({ source: "docs/agent_guide.md", capability: "gen-new-compatible" });
  for (const file of files.filter((f) => /(^|\/)harness[-.]lint\./.test(f)))
    facts.push({ source: file, capability: "existing-lint-candidate", action: "Declare argv explicitly; never executed during inspection" });
  return { facts, questions, suggestedConfig: config, files };
}
var visibilityQuestion = { id: "visibility", type: "visibility", message: "Repository visibility: private, public, or unknown?" };

// src/planner.mjs
import fs6 from "fs";

// src/templates.mjs
var managedPaths = ["harness.config.json", "README.md", ".gitignore", "docs/agent_guide.md", "docs/structure.md"];
var directories = ["docs/prd", "docs/decision", "docs/verification", "docs/public/guides", "docs/public/reference", "docs/public/examples", "scripts"];
var readme = `# \u9879\u76EE\u8BF4\u660E

\u672C\u6587\u662F\u9879\u76EE\u6839\u76EE\u5F55\u7684\u516C\u5F00\u5165\u53E3\uFF0C\u7528\u4E8E\u4ECB\u7ECD\u9879\u76EE\u7528\u9014\u3001\u5B89\u88C5\u3001\u5FEB\u901F\u5F00\u59CB\u4E0E\u9A8C\u8BC1\u547D\u4EE4\u3002\u8BF7\u6309\u5B9E\u9645\u9879\u76EE\u8865\u5145\u8BF4\u660E\uFF0C\u5185\u5BB9\u5E94\u9002\u5408\u516C\u5F00\u3002

\u8BE6\u7EC6\u516C\u5F00\u6587\u6863\u6309\u7528\u9014\u653E\u5728 docs/public/guides\u3001docs/public/reference\u3001docs/public/examples\uFF1B\u6709\u5B9E\u9645\u5185\u5BB9\u540E\u518D\u6DFB\u52A0\u5BF9\u5E94\u94FE\u63A5\u3002

\u9879\u76EE\u7EA6\u5B9A\u68C0\u67E5\uFF1Aharness lint\uFF1B\u8FD0\u884C\u5DF2\u914D\u7F6E\u9A8C\u8BC1\uFF1Aharness verify\u3002\u672A\u914D\u7F6E\u6D4B\u8BD5\u4E0D\u4EE3\u8868\u6D4B\u8BD5\u901A\u8FC7\u3002
`;
var structure = `# \u6587\u6863\u76EE\u5F55\u4E0E\u8D44\u6599\u8FB9\u754C

\u672C\u6587\u662F\u5185\u90E8\u534F\u4F5C\u8BF4\u660E\uFF0C\u89E3\u91CA\u6587\u6863\u804C\u8D23\u4E0E\u653E\u7F6E\u65B9\u5F0F\u3002

| \u8DEF\u5F84 | \u7528\u9014 | \u516C\u5F00\u8FB9\u754C |
|---|---|---|
| \u6839 README.md | \u9879\u76EE\u4ECB\u7ECD\u3001\u5B89\u88C5\u3001\u5FEB\u901F\u5F00\u59CB\u4E0E\u516C\u5F00\u6587\u6863\u5165\u53E3 | \u9ED8\u8BA4\u516C\u5F00 |
| docs/public/guides | \u9762\u5411\u4F7F\u7528\u8005\u7684\u64CD\u4F5C\u6307\u5357 | \u516C\u5F00 |
| docs/public/reference | \u63A5\u53E3\u3001\u914D\u7F6E\u548C\u547D\u4EE4\u53C2\u8003 | \u516C\u5F00 |
| docs/public/examples | \u4F7F\u7528\u793A\u4F8B\u4E0E\u914D\u5957\u8BF4\u660E | \u516C\u5F00 |
| docs/prd | \u5185\u90E8\u9700\u6C42\u4E0E\u9A8C\u6536\u6807\u51C6 | \u5185\u90E8 |
| docs/decision | \u91CD\u8981\u6280\u672F\u51B3\u7B56\u4E0E\u53D6\u820D | \u5185\u90E8 |
| docs/verification | \u9A8C\u6536\u65B9\u6CD5\u3001\u547D\u4EE4\u548C\u6D4B\u8BD5\u94FE\u63A5 | \u5185\u90E8 |
| docs/agent_guide.md | Agent \u534F\u4F5C\u4E0E\u9A8C\u8BC1\u89C4\u8303 | \u5185\u90E8 |
| docs/structure.md | \u672C\u76EE\u5F55\u8BF4\u660E | \u5185\u90E8 |
| MEMORY.md\u3001memory | \u5F00\u53D1\u7ECF\u9A8C\u548C\u8FC7\u7A0B\u8BB0\u5F55 | \u5185\u90E8 |
| .harness | \u7B54\u6848\u3001\u8BA1\u5212\u548C\u53D7\u7BA1\u7406\u6587\u4EF6\u6458\u8981 | \u5185\u90E8 |

\u6D4B\u8BD5\u4EE3\u7801\u4FDD\u7559\u6846\u67B6\u539F\u751F\u76EE\u5F55\uFF1Bdocs/verification \u4EC5\u8BF4\u660E\u5982\u4F55\u9A8C\u6536\uFF0C\u4E0D\u5B58\u653E\u53EF\u6267\u884C\u6D4B\u8BD5\u3002scripts \u8D1F\u8D23\u8C03\u7528\uFF0C\u62A5\u544A\u4E0E\u8986\u76D6\u7387\u653E\u6846\u67B6\u4EA7\u7269\u76EE\u5F55\u6216 artifacts\u3002

\u5185\u90E8\u8D44\u6599\u53EF\u4EE5\u63D0\u4EA4\u79C1\u6709 Git\u3002\u516C\u5F00\u4ED3\u5E93\u5E94\u4F7F\u7528\u79C1\u6709\u4F34\u968F\u4ED3\u5E93\u6216\u4E0D\u8DDF\u8E2A\u7684\u672C\u5730\u8D44\u6599\uFF1Bgitignore \u4E0D\u4F1A\u6E05\u7406\u5DF2\u8DDF\u8E2A\u6587\u4EF6\u548C\u5386\u53F2\u3002\u516C\u5F00\u524D\u68C0\u67E5\u5B9E\u9645\u4EA7\u7269\uFF0C\u79C1\u6709\u4ED3\u5E93\u76F4\u63A5\u8F6C\u516C\u5F00\u8FD8\u9700\u5BA1\u9605\u5168\u90E8\u76F8\u5173\u5386\u53F2\u4E0E\u6258\u7BA1\u8D44\u6599\u3002
`;
var guide = `# \u9879\u76EE\u534F\u4F5C\u4E0E\u9A8C\u8BC1

\u9879\u76EE\u7EA6\u5B9A\u7531 harness.config.json \u8BB0\u5F55\u3002\u5148\u8BFB\u53D6\u76F8\u5173\u9700\u6C42\u4E0E\u51B3\u7B56\uFF0C\u518D\u4FEE\u6539\u4EE3\u7801\u3002\u6587\u6863\u804C\u8D23\u89C1 docs/structure.md\u3002

- \u6839 README.md \u9ED8\u8BA4\u516C\u5F00\uFF1B\u8BE6\u7EC6\u516C\u5F00\u6587\u6863\u653E docs/public/guides\u3001reference\u3001examples\u3002
- docs/prd\uFF1A\u9700\u6C42\uFF1Bdocs/decision\uFF1A\u91CD\u8981\u51B3\u7B56\uFF1Bdocs/verification\uFF1A\u9A8C\u6536\u8BF4\u660E\u3002
- memory\u3001decision \u7B49\u8FC7\u7A0B\u6750\u6599\u53EF\u8FDB\u79C1\u6709 Git\uFF0C\u9ED8\u8BA4\u4E0D\u53EF\u516C\u5F00\u3002
- \u6D4B\u8BD5\u4EE3\u7801\u4FDD\u7559\u6846\u67B6\u539F\u751F\u76EE\u5F55\uFF1B\u9A8C\u6536\u8BF4\u660E\u94FE\u63A5\u6D4B\u8BD5\u4E0E\u547D\u4EE4\uFF0C\u4E0D\u91CD\u590D\u6284\u5199\u65AD\u8A00\u3002
- scripts \u4EC5\u4F5C\u7F16\u6392\uFF1B\u62A5\u544A\u653E\u6846\u67B6\u4EA7\u7269\u76EE\u5F55\u3002\u4E0D\u8981\u4E3A\u7B80\u5355\u4FEE\u6539\u5236\u9020\u65E0\u4FE1\u606F\u4EF7\u503C\u7684\u6587\u6863\u3002
- \u4F7F\u7528 harness lint \u68C0\u67E5\u7EA6\u5B9A\uFF0Charness verify \u6267\u884C\u914D\u7F6E\u4EFB\u52A1\uFF1B\u6CA1\u6709\u6D4B\u8BD5\u4E0D\u7B49\u4E8E\u6D4B\u8BD5\u901A\u8FC7\u3002
- \u53D1\u5E03\u524D\u68C0\u67E5\u5B9E\u9645\u4EA7\u7269\uFF1B\u539F\u4ED3\u5E93\u8F6C\u516C\u5F00\u8FD8\u9700\u5386\u53F2\u4E0E\u6258\u7BA1\u8D44\u6599\u5BA1\u9605\u3002
`;
function gitignore(visibility) {
  const common = `# Dependencies and generated output
node_modules/
/artifacts/
/coverage/
/dist/
/build/

# Local environment (keep distributable examples)
.env
.env.*
!.env.example
!.env.sample
*.log
.DS_Store
Thumbs.db

# Local harness answers, plans and temporary data
/.harness/*
!/.harness/managed.json
`;
  return common + (visibility === "public" ? `
# Internal development material in a public repository
/.harness/
/docs/prd/
/docs/decision/
/docs/verification/
/docs/agent_guide.md
/docs/structure.md
MEMORY.md
memory/
memories/
decision/
decisions/
` : "");
}

// src/planner.mjs
var STATE = ".harness/managed.json";
function makePlan(root, answers = {}) {
  const scan = inspect(root);
  let config = structuredClone(scan.suggestedConfig);
  const allowed = ["visibility", "managers", "testCommands", "config", "acknowledge"];
  for (const k of Object.keys(answers))
    if (!allowed.includes(k))
      throw new Error(`Unknown answers field: ${k}`);
  if (answers.config)
    config = answers.config;
  if (answers.visibility)
    config.repository = { visibility: answers.visibility };
  for (const [workspace, argv] of Object.entries(answers.testCommands ?? {})) {
    config.tasks = config.tasks.filter((t) => !(t.workspace === workspace && t.kind === "test"));
    if (argv !== null)
      config.tasks.push({ id: `${workspace}:test`, workspace, kind: "test", argv });
  }
  if (answers.managers)
    for (const w of config.workspaces) {
      const manager = answers.managers[w.id];
      if (!manager)
        continue;
      if (!["pnpm", "bun", "npm", "yarn"].includes(manager))
        throw new Error(`Unsupported manager suggestion: ${manager}; use config.tasks for custom argv`);
      const pkgPath = w.root === "." ? "package.json" : `${w.root}/package.json`;
      if (fs6.existsSync(safePath(root, pkgPath))) {
        const pkg = readJson(root, pkgPath);
        for (const [name, kind] of [["test", "test"], ["lint", "lint"], ["typecheck", "typecheck"], ["harness-lint", "lint"]])
          if (pkg.scripts?.[name] && !config.tasks.some((t) => t.id === `${w.id}:${name}`) && !(kind === "test" && Object.hasOwn(answers.testCommands ?? {}, w.id))) {
            if (/no test specified|--recursive|(?:^|\s)-r(?:\s|$)|--workspaces|turbo\s|nx\s|--filter|harness.*\s(?:verify|lint)/.test(pkg.scripts[name]))
              continue;
            config.tasks.push({ id: `${w.id}:${name}`, workspace: w.id, kind, argv: [manager, "run", name] });
          }
      }
    }
  config = validateConfig(config, root);
  const unanswered = scan.questions.filter((q) => {
    if (q.type === "visibility")
      return config.repository.visibility === "unknown" && !Object.hasOwn(answers, "visibility") && !answers.config;
    if (q.type === "manager")
      return !answers.managers?.[q.workspace] && !answers.config;
    if (q.type === "test-command")
      return !config.tasks.some((t) => t.workspace === q.workspace && t.kind === "test") && !Object.hasOwn(answers.testCommands ?? {}, q.workspace) && !answers.config;
    return !(answers.acknowledge ?? []).includes(q.id) && !answers.config;
  });
  const previous = fs6.existsSync(safePath(root, STATE)) ? readJson(root, STATE) : { files: {} };
  const contents = { [CONFIG]: json(config), "docs/agent_guide.md": guide, "docs/structure.md": structure, ".gitignore": gitignore(config.repository.visibility) };
  if (fileHash(root, "README.md") === null || previous.files?.["README.md"])
    contents["README.md"] = readme;
  const files = Object.entries(contents).map(([name, content]) => {
    const before = fileHash(root, name), after = hash(content);
    const action = before === after ? "unchanged" : before === null ? "create" : previous.files?.[name] === before ? "update" : "conflict";
    return { path: name, before, after, action, content };
  });
  const plan = { version: 1, root: fs6.realpathSync(root), files, directories, stateBefore: fileHash(root, STATE), unanswered, facts: scan.facts };
  return { ...plan, digest: digest(plan) };
}
function applyPlan(root, plan) {
  const { digest: expected, ...body } = plan;
  if (plan.version !== 1 || digest(body) !== expected || fs6.realpathSync(root) !== plan.root)
    throw new Error("Invalid, altered or wrong-root plan");
  if (plan.files.some((f) => !managedPaths.includes(f.path) || !["create", "update", "unchanged", "conflict"].includes(f.action)) || new Set(plan.files.map((f) => f.path)).size !== plan.files.length)
    throw new Error("Plan contains unsupported managed files");
  if (plan.directories.some((p) => !directories.includes(p) && p !== "docs/public"))
    throw new Error("Plan contains unsupported directories");
  if (plan.unanswered.length)
    throw new Error("Resolve plan.unanswered using answers before apply");
  if (fileHash(root, STATE) !== plan.stateBefore)
    throw new Error("Managed state changed since plan");
  for (const dir of plan.directories)
    safePath(root, dir);
  for (const f of plan.files) {
    if (f.action === "conflict")
      continue;
    if (fileHash(root, f.path) !== f.before || hash(f.content) !== f.after)
      throw new Error(`Stale plan: ${f.path}`);
    if (f.path === CONFIG)
      validateConfig(JSON.parse(f.content), root);
  }
  const changed = [], backups = [], previous = plan.stateBefore ? readJson(root, STATE) : { files: {} };
  const state = { version: 1, files: { ...previous.files } };
  try {
    for (const f of plan.files) {
      if (f.action === "conflict")
        continue;
      state.files[f.path] = f.after;
      if (f.action === "unchanged")
        continue;
      backups.push({ path: f.path, before: f.before === null ? null : fs6.readFileSync(safePath(root, f.path)), written: f.after });
      atomicWrite(root, f.path, f.content);
      changed.push(f.path);
    }
    for (const dir of plan.directories)
      fs6.mkdirSync(safePath(root, dir), { recursive: true });
    const content = json(state);
    if (fileHash(root, STATE) !== hash(content))
      atomicWrite(root, STATE, content);
  } catch (error) {
    for (const b of backups.reverse())
      if (fileHash(root, b.path) === b.written) {
        if (b.before === null)
          fs6.unlinkSync(safePath(root, b.path));
        else
          atomicWrite(root, b.path, b.before);
      }
    throw error;
  }
  const conflicts = plan.files.filter((f) => f.action === "conflict").map((f) => f.path);
  return { status: conflicts.length ? "conflicts" : "applied", exitCode: conflicts.length ? 1 : 0, changed, conflicts };
}

// src/lint.mjs
import fs8 from "fs";
import path5 from "path";

// src/report.mjs
function finding(ruleId, location, message, { severity = "error", workspace = "root", protectedRule = false, detail } = {}) {
  return { ruleId, path: location, workspace, severity, message, protected: protectedRule, fingerprint: digest({ ruleId, location, workspace, detail }), ...detail ? { detail } : {} };
}
function report(findings = [], extra = {}) {
  return { status: findings.some((f) => f.severity === "error") ? "failed" : "passed", exitCode: findings.some((f) => f.severity === "error") ? 1 : 0, findings, ...extra };
}

// src/runner.mjs
import fs7 from "fs";
import path4 from "path";
function taskOrder(tasks, selected) {
  const byId = new Map(tasks.map((t) => [t.id, t])), visiting = new Set, visited = new Set, result = [];
  function visit(id2) {
    if (visited.has(id2))
      return;
    if (visiting.has(id2))
      throw new Error(`Task dependency cycle: ${id2}`);
    const task = byId.get(id2);
    if (!task)
      throw new Error(`Unknown task: ${id2}`);
    visiting.add(id2);
    for (const dep of task.dependsOn ?? [])
      visit(dep);
    visiting.delete(id2);
    visited.add(id2);
    result.push(task);
  }
  for (const id2 of selected ?? tasks.map((t) => t.id))
    visit(id2);
  return result;
}
function launchCommand(argv) {
  const [command, ...args] = argv;
  if (command === "bun")
    return { command: process.execPath, args };
  if (process.platform !== "win32" || /\.exe$/i.test(command))
    return { command, args };
  const candidates = path4.isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(path4.delimiter).flatMap((dir) => [path4.join(dir, command), ...[".exe", ".cmd", ".bat"].map((ext) => path4.join(dir, command + ext))]);
  const resolved = candidates.find((p) => fs7.existsSync(p) && fs7.statSync(p).isFile());
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved))
    return { command: resolved ?? command, args };
  for (const token of [resolved, ...args])
    if (/["&|<>^%!\r\n]/.test(token))
      throw new Error("Unsafe argument for Windows .cmd shim; use a native executable or JS entrypoint");
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${[resolved, ...args].map((x) => `"${x}"`).join(" ")}"`], windowsVerbatimArguments: true };
}
async function runTask(root, config, task, signal) {
  const w = config.workspaces.find((w2) => w2.id === task.workspace);
  const cwd = safePath(root, w.root === "." ? task.cwd : `${w.root}/${task.cwd}`, { allowMissing: false });
  const launch = launchCommand(task.argv);
  const start = Date.now();
  let output = "", reason = null;
  const readers = [];
  const child = Bun.spawn([launch.command, ...launch.args], { cwd, windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments, detached: process.platform !== "win32", env: { ...process.env, HARNESS_ACTIVE: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  async function capture(stream) {
    const reader = stream.getReader();
    readers.push(reader);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        output = (output + Buffer.from(value).toString()).slice(-32768);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const streams = Promise.all([capture(child.stdout), capture(child.stderr)]);
  function stop(why) {
    reason = why;
    if (process.platform === "win32")
      Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdout: "ignore", stderr: "ignore", timeout: 2000 });
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    try {
      child.kill("SIGKILL");
    } catch {}
    for (const reader of readers) {
      try {
        reader.cancel().catch(() => {});
      } catch {}
    }
  }
  const timeout = setTimeout(() => stop("timeout"), task.timeoutMs), abort = () => stop("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted)
    abort();
  try {
    const code = await child.exited;
    await streams;
    return { id: task.id, workspace: task.workspace, required: task.required, status: reason ? "blocked" : code === 0 ? "passed" : "failed", code, reason, durationMs: Date.now() - start, output };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
async function verify(root, config, { selected, signal } = {}) {
  if (process.env.HARNESS_ACTIVE)
    throw new Error("Recursive harness invocation refused; configure underlying commands instead");
  const ordered = taskOrder(config.tasks, selected), results = [], done = new Map;
  for (const task of ordered) {
    let result;
    if (signal?.aborted)
      result = { status: "blocked", reason: "cancelled" };
    else if (!task.enabled)
      result = { status: "skipped", reason: "disabled" };
    else if (task.dependsOn.some((id2) => done.get(id2)?.status !== "passed"))
      result = { status: "blocked", reason: "dependency-not-passed" };
    else {
      try {
        result = await runTask(root, config, task, signal);
      } catch (error) {
        result = { status: "blocked", reason: error.message };
      }
    }
    result = { id: task.id, workspace: task.workspace, required: task.required, ...result };
    results.push(result);
    done.set(task.id, result);
  }
  const workspaces = config.workspaces.map((w) => {
    const tests2 = ordered.filter((t) => t.kind === "test" && t.covers.includes(w.id));
    if (selected && !tests2.length)
      return { id: w.id, status: "not-selected", required: false };
    return { id: w.id, status: !tests2.length ? "not-configured" : tests2.every((t) => done.get(t.id)?.status === "passed") ? "passed" : "incomplete", required: effectiveTests(config, w).requireConfiguredTask };
  });
  const failed = results.some((r) => r.required && r.status !== "passed") || workspaces.some((w) => w.required && w.status !== "passed");
  return { status: failed ? "failed" : results.length ? "passed" : "not-configured", exitCode: failed ? results.some((r) => r.required && r.status === "blocked") ? 2 : 1 : 0, scope: selected ? "selected-tasks" : "all-tasks", tasks: results, workspaces };
}

// src/git.mjs
import { spawnSync } from "child_process";

// src/policy.mjs
var protectedPatterns = ["**/.git/**", "**/.git", "**/MEMORY.md", "**/memory/**", "**/memories/**", "**/decision/**", "**/decisions/**"];
function classify(c, name) {
  name = relativePath(name);
  const internal = [], publicMatches = [];
  for (const p of protectedPatterns)
    if (matches(name, p))
      internal.push(`protected:${p}`);
  function collect(policy, prefix, source) {
    const qualify = (p) => prefix === "." ? p : p === "." ? prefix : `${prefix}/${p}`;
    for (const [key, list] of [["internalRoots", internal], ["publicRoots", publicMatches]])
      for (const p of policy?.[key] ?? [])
        if (under(name, qualify(p)))
          list.push(`${source}:${key}:${p}`);
    for (const [key, list] of [["internalPatterns", internal], ["publicPatterns", publicMatches]])
      for (const p of policy?.[key] ?? [])
        if (matches(name, qualify(p)))
          list.push(`${source}:${key}:${p}`);
  }
  collect(c.documents, ".", "root");
  for (const w of c.workspaces)
    if (w.documents)
      collect(w.documents, w.root, w.id);
  return { audience: internal.length ? "internal" : publicMatches.length ? "public" : "unknown", reasons: [...internal, ...publicMatches], conflict: internal.length > 0 && publicMatches.length > 0 };
}

// src/git.mjs
function git(root, args, { binary = false, optional = false } = {}) {
  const result = spawnSync("git", ["--no-replace-objects", "-C", root, ...args], { encoding: binary ? undefined : "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  if (result.error || result.status !== 0) {
    if (optional)
      return null;
    throw new Error(`Git ${args[0]} unavailable or incomplete (${result.error?.code ?? result.status})`);
  }
  return result.stdout;
}
var isGit = (root) => git(root, ["rev-parse", "--is-inside-work-tree"], { optional: true })?.trim() === "true";
function gitScope(root, config) {
  const refs = git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, oid] = line.split(" ");
    return { name, oid };
  });
  const head = git(root, ["rev-parse", "--verify", "HEAD"], { optional: true })?.trim() ?? null;
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  const remoteDigest = hash(git(root, ["remote", "-v"]));
  const policyDigest = digest(config);
  return { refs, head, shallow, remoteDigest, policyDigest, scopeDigest: digest({ refs, head, shallow, remoteDigest, policyDigest }) };
}
var privacyFinding = (rule, name, message, detail) => finding(rule, name, message, { protectedRule: true, detail });
function entries(output) {
  return output.split("\x00").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t"), [mode, type, oid] = row.slice(0, tab).split(" ");
    return { mode, type, oid, path: row.slice(tab + 1) };
  });
}
function historyInventory(root, { onProgress } = {}) {
  const commits = git(root, ["rev-list", "--all", ...git(root, ["rev-parse", "--verify", "HEAD"], { optional: true }) ? ["HEAD"] : []]).trim().split(/\r?\n/).filter(Boolean);
  const records = [], blobs = new Map, trees = new Set;
  for (const [i, commit] of commits.entries()) {
    onProgress?.({ phase: "history", current: i + 1, total: commits.length });
    const tree = git(root, ["rev-parse", `${commit}^{tree}`]).trim();
    if (trees.has(tree))
      continue;
    trees.add(tree);
    for (const entry of entries(git(root, ["ls-tree", "-r", "-z", commit]))) {
      records.push({ ...entry, commit });
      if (entry.type === "blob" && !blobs.has(entry.oid))
        blobs.set(entry.oid, git(root, ["cat-file", "blob", entry.oid], { binary: true }));
    }
  }
  return { records, blobs };
}
function knownInternal(config, inventory) {
  const oids = new Set;
  for (const e of inventory.records) {
    try {
      if (classify(config, e.path).audience === "internal")
        oids.add(e.oid);
    } catch {
      oids.add(e.oid);
    }
  }
  return oids;
}
function internalHistoryHashes(root, config) {
  if (!isGit(root))
    return new Set;
  const data = historyInventory(root), internal = knownInternal(config, data);
  return new Set([...internal].filter((oid) => data.blobs.has(oid)).map((oid) => hash(data.blobs.get(oid))));
}
function inspectRecord(config, e, blob, internalOids) {
  const findings = [];
  let classification;
  try {
    relativePath(e.path);
    classification = classify(config, e.path);
  } catch {
    findings.push(privacyFinding("publication.path", e.path, "Unsafe historical path"));
    return findings;
  }
  if (e.mode === "120000" || e.mode === "160000")
    findings.push(privacyFinding("publication.nested-resource", e.path, "Symlink or submodule requires independent reviewed export", e.commit));
  if (classification.audience !== "public" || internalOids.has(e.oid))
    findings.push(privacyFinding("publication.internal-history", e.path, internalOids.has(e.oid) ? "Known internal content exists in reachable history/index" : "Historical/index file is not explicitly public", e.commit ?? e.oid));
  if (blob?.subarray(0, 150).toString().startsWith("version https://git-lfs.github.com/spec/v1"))
    findings.push(privacyFinding("publication.lfs", e.path, "LFS object audit is unsupported: supply a reviewed snapshot instead", e.commit));
  return findings;
}
function auditIndex(root, config) {
  if (!isGit(root))
    return report([privacyFinding("publication.git-unavailable", ".git", "Public repository index cannot be checked")], { exitCode: 2 });
  try {
    const data = historyInventory(root), internal = knownInternal(config, data);
    const staged = git(root, ["ls-files", "--stage", "-z"]).split("\x00").filter(Boolean).map((row) => {
      const tab = row.indexOf("\t"), [mode, oid, stage] = row.slice(0, tab).split(" ");
      return { mode, oid, stage, type: "blob", path: row.slice(tab + 1) };
    });
    for (const e of staged)
      if (classify(config, e.path).audience === "internal")
        internal.add(e.oid);
    const findings = staged.flatMap((e) => e.stage !== "0" ? [privacyFinding("publication.index-conflict", e.path, "Unmerged index cannot be published")] : inspectRecord(config, e, git(root, ["cat-file", "blob", e.oid], { binary: true }), internal));
    return report(findings, { coverage: "index-and-known-internal-history" });
  } catch (error) {
    return report([privacyFinding("publication.git-incomplete", ".git", error.message)], { exitCode: 2 });
  }
}
function reviewTemplate(root, config) {
  const scope = gitScope(root, config);
  return {
    version: 1,
    scopeDigest: scope.scopeDigest,
    reviewer: "",
    reference: "",
    visibility: config.repository.visibility,
    remoteRefs: null,
    platform: Object.fromEntries(["issues", "pullRequests", "wiki", "releases", "actions", "other"].map((name) => [name, { status: "pending", reference: "" }])),
    instructions: "Manually inventory ALL remote refs and platform content. Fill reviewer/reference and each section. This is a reviewer attestation, not an automatic platform audit."
  };
}
function auditHistory(root, config, { evidence, onProgress } = {}) {
  const findings = [];
  try {
    const scope = gitScope(root, config);
    if (scope.shallow)
      findings.push(privacyFinding("publication.shallow", ".git", "Shallow repository cannot pass full-history review"));
    if (scope.refs.some((r) => r.name.startsWith("refs/replace/")))
      findings.push(privacyFinding("publication.replace", ".git", "Replace refs require separate review"));
    if (!scope.head)
      findings.push(privacyFinding("publication.no-history", ".git", "No HEAD to bind repository publication evidence"));
    if (config.repository.visibility === "unknown")
      findings.push(privacyFinding("publication.visibility", ".git", "Repository visibility is unknown"));
    const inventory = historyInventory(root, { onProgress }), internal = knownInternal(config, inventory), seen = new Set;
    for (const entry of inventory.records) {
      const key = `${entry.path}\x00${entry.oid}`;
      if (seen.has(key))
        continue;
      seen.add(key);
      findings.push(...inspectRecord(config, entry, inventory.blobs.get(entry.oid), internal));
    }
    const validText = (value) => typeof value === "string" && value.trim().length > 0;
    if (!evidence || evidence.version !== 1 || evidence.scopeDigest !== scope.scopeDigest || !validText(evidence.reviewer) || !validText(evidence.reference) || evidence.visibility !== config.repository.visibility)
      findings.push(privacyFinding("publication.review", ".git", "Missing, incomplete or stale reviewer evidence bound to this scope"));
    else {
      if (!Array.isArray(evidence.remoteRefs))
        findings.push(privacyFinding("publication.remote-refs", ".git", "Remote ref inventory has not been attested"));
      else
        for (const r of evidence.remoteRefs)
          if (!r || !validText(r.name) || !validText(r.oid) || !scope.refs.some((local) => local.oid === r.oid && (local.name === r.name || local.name.replace(/^refs\/remotes\/[^/]+\//, "refs/heads/") === r.name)))
            findings.push(privacyFinding("publication.remote-refs", ".git", "An attested remote ref is absent or stale locally"));
      for (const section of ["issues", "pullRequests", "wiki", "releases", "actions", "other"]) {
        const item = evidence.platform?.[section];
        if (!item || !["reviewed", "not-applicable"].includes(item.status) || !validText(item.reference))
          findings.push(privacyFinding("publication.platform-review", section, "Platform section has not been explicitly reviewed"));
      }
    }
    return report(findings, { scope, commitsAndFilesScanned: inventory.records.length, coverage: "reachable-local-refs plus explicit human remote/platform attestation", automaticPlatformAudit: false });
  } catch (error) {
    return report([...findings, privacyFinding("publication.git-incomplete", ".git", error.message)], { exitCode: 2 });
  }
}

// src/lint.mjs
function applyBaseline(findings, baseline) {
  return findings.map((f) => !f.protected && baseline.includes(f.fingerprint) ? { ...f, severity: "warning", baseline: true } : f);
}
function lint(root, config, { useBaseline = true } = {}) {
  const findings = [], entries2 = walk(root, { ignore: [".git", "node_modules", ".harness"] }), files = entries2.filter((e) => e.type === "file").map((e) => e.path);
  const add = (rule, name, message, workspace = "root", detail) => {
    const severity = config.rules[rule] ?? "error";
    if (severity !== "off")
      findings.push(finding(rule, name, message, { severity, workspace, detail }));
  };
  try {
    taskOrder(config.tasks);
  } catch (error) {
    add("tasks.graph", "harness.config.json", error.message, "root", error.message);
  }
  const workspaceResults = [];
  for (const w of config.workspaces) {
    const policy = effectiveTests(config, w);
    const tasks = config.tasks.filter((t) => t.kind === "test" && t.covers.includes(w.id));
    workspaceResults.push({ id: w.id, tests: tasks.length ? "configured" : "not-configured", source: w.tests ? `workspaces.${w.id}.tests (inherits root)` : "tests (root)" });
    if (!tasks.length && policy.requireConfiguredTask)
      add("tests.configured", w.root, "Required test task is not configured", w.id);
    for (const file of files.filter((f) => under(f, w.root))) {
      const owners = config.workspaces.filter((other) => other.root !== w.root && under(other.root, w.root) && under(file, other.root));
      if (owners.length)
        continue;
      const local = w.root === "." ? file : file.slice(w.root.length + 1);
      if (policy.exclude.some((p) => matches(local, p)))
        continue;
      const looksLikeTest = /(?:\.test\.[^/]+|\.spec\.[^/]+|_test\.go)$/.test(local);
      if (looksLikeTest && policy.artifacts.some((p) => under(local, p)))
        add("tests.artifacts", file, "Test code is inside an artifact directory", w.id);
      else if (looksLikeTest && policy.include.length && !policy.include.some((p) => matches(local, p)))
        add("tests.layout", file, "Test is outside the configured framework discovery paths", w.id);
    }
  }
  for (const file of files.filter((f) => f.startsWith("docs/verification/") && f.endsWith(".md"))) {
    const text = fs8.readFileSync(safePath(root, file), "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].replace(/^<|>$/g, "");
      if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(link))
        continue;
      try {
        const target = path5.posix.normalize(path5.posix.join(path5.posix.dirname(file), decodeURIComponent(link.split("#")[0])));
        if (!fs8.existsSync(safePath(root, target)))
          add("documents.links", file, `Missing verification link: ${target}`, "root", target);
      } catch {
        add("documents.links", file, "Unsafe verification link", "root", link);
      }
    }
  }
  if (config.repository.visibility === "public")
    findings.push(...auditIndex(root, config).findings);
  const applied = useBaseline ? applyBaseline(findings, config.baseline) : findings;
  return report(applied, { workspaces: workspaceResults, baselineAccepted: applied.filter((f) => f.baseline).length });
}

// src/publication.mjs
import fs9 from "fs";
import path6 from "path";
var fail = (rule, name, message) => finding(`publication.${rule}`, name, message, { protectedRule: true });
var archives = /\.(zip|tar|gz|tgz|7z|rar|jar|war|bz2|xz)$/i;
function internalHashes(root, config) {
  const result = internalHistoryHashes(root, config);
  for (const file of walk(root).filter((e) => e.type === "file"))
    if (classify(config, file.path).audience === "internal")
      result.add(fileHash(root, file.path));
  return result;
}
function linkFindings(root, config, name, text, { artifactFiles, artifactRoot } = {}) {
  if (!/\.(md|mdx|html?)$/i.test(name))
    return [];
  const findings = [];
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g), ...text.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  for (let link of links) {
    link = link.replace(/^<|>$/g, "").split(/[?#]/)[0];
    if (!link || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(link))
      continue;
    try {
      link = decodeURIComponent(link);
      const target = path6.posix.normalize(link.startsWith("/") ? link.slice(1) : path6.posix.join(path6.posix.dirname(name), link));
      relativePath(target);
      if (artifactFiles) {
        const possible = [target, `${target}/index.html`, `${target}.html`];
        if (!possible.some((p) => artifactFiles.has(p)))
          findings.push(fail("link", name, `Public artifact link is absent from inspected output: ${target}`));
        if (classify(config, target).audience === "internal")
          findings.push(fail("link", name, `Public link names internal content: ${target}`));
      } else if (classify(config, target).audience !== "public" || !fs9.existsSync(safePath(root, target)))
        findings.push(fail("link", name, `Source link is not a known public file: ${target}`));
    } catch {
      findings.push(fail("link", name, "Unsafe or malformed local public link"));
    }
  }
  return findings;
}
function checkManifest(root, config, manifest) {
  const findings = [];
  try {
    if (!manifest || manifest.version !== 1 || typeof manifest.target !== "string" || !manifest.target || !Array.isArray(manifest.entries))
      throw new Error("Expected manifest version 1, target, artifactRoot and entries");
    const artifactRoot = safePath(root, manifest.artifactRoot, { allowMissing: false });
    if (!fs9.statSync(artifactRoot).isDirectory())
      throw new Error("artifactRoot must be a directory");
    const actual = walk(artifactRoot, { ignore: [] }), seen = new Set, internal = internalHashes(root, config), snapshot = [];
    const actualFiles = new Set(actual.map((e) => e.path));
    for (const e of actual.filter((e2) => e2.type !== "file"))
      findings.push(fail("path", e.path, `Unsupported publication entry: ${e.type}`));
    for (const entry of manifest.entries) {
      relativePath(entry.path);
      if (seen.has(entry.path.toLowerCase()))
        throw new Error(`Duplicate/case-colliding manifest path: ${entry.path}`);
      seen.add(entry.path.toLowerCase());
      const location = safePath(artifactRoot, entry.path, { allowMissing: false });
      if (!fs9.statSync(location).isFile())
        throw new Error(`Not a file: ${entry.path}`);
      const bytes = fs9.readFileSync(location), checksum = hash(bytes);
      snapshot.push({ path: entry.path, sha256: checksum });
      if (checksum !== entry.sha256)
        findings.push(fail("digest", entry.path, "Output differs from reviewed manifest hash"));
      if (internal.has(checksum))
        findings.push(fail("internal-copy", entry.path, "Output is a byte-identical copy of known internal current/historical content"));
      if (archives.test(entry.path))
        findings.push(fail("archive", entry.path, "Archive contents are not audited; supply an extracted tree and publish only the checked format"));
      if (classify(config, entry.path).audience === "internal")
        findings.push(fail("internal", entry.path, "Output path is explicitly internal"));
      if (!Array.isArray(entry.sources) || !entry.sources.length) {
        findings.push(fail("unknown-source", entry.path, "Output has no provenance"));
        continue;
      }
      let directCopy = false;
      for (const source of entry.sources) {
        relativePath(source.path);
        if (classify(config, source.path).audience !== "public")
          findings.push(fail("internal-source", entry.path, `Source is not explicitly public: ${source.path}`));
        const sourceBytes = fs9.readFileSync(safePath(root, source.path, { allowMissing: false })), sourceHash = hash(sourceBytes);
        if (sourceHash !== source.sha256)
          findings.push(fail("source-digest", entry.path, `Source changed: ${source.path}`));
        if (internal.has(sourceHash))
          findings.push(fail("internal-copy", entry.path, `Source copies known internal content: ${source.path}`));
        if (sourceHash === checksum)
          directCopy = true;
        findings.push(...linkFindings(root, config, source.path, sourceBytes.toString("utf8")));
      }
      if (!directCopy && !(entry.review?.reviewer?.trim() && entry.review?.reference?.trim()))
        findings.push(fail("generated-review", entry.path, "Transformed output needs explicit reviewer/reference for complete provenance"));
      findings.push(...linkFindings(root, config, entry.path, bytes.toString("utf8"), { artifactFiles: actualFiles, artifactRoot }));
    }
    for (const file of actual)
      if (!seen.has(file.path.toLowerCase()))
        findings.push(fail("unlisted", file.path, "Actual output contains a file missing from manifest"));
    if (!manifest.entries.length)
      findings.push(fail("empty", manifest.artifactRoot, "No publication files were inspected"));
    return report(findings, { target: manifest.target, policyDigest: digest(config), manifestDigest: digest(manifest), artifactDigest: digest(snapshot.sort((a, b) => a.path.localeCompare(b.path))), files: snapshot, coverage: "actual output tree and declared/reviewed provenance" });
  } catch (error) {
    return report([...findings, fail("incomplete", "manifest", error.message)], { exitCode: 2 });
  }
}
function publicationCheck(root, config, { target, manifestPath } = {}) {
  if (manifestPath)
    return checkManifest(root, config, readJson(root, manifestPath));
  const targets = config.publicationTargets.filter((t) => !target || t.id === target);
  if (!targets.length)
    return report([fail("not-configured", target ?? "publicationTargets", "No matching publication target configured")], { exitCode: 2 });
  const reports = targets.map((t) => ({ id: t.id, ...checkManifest(root, config, readJson(root, t.manifest)) }));
  return report(reports.flatMap((r) => r.findings), { targets: reports, exitCode: Math.max(...reports.map((r) => r.exitCode)) });
}
function exportSnapshot(root, config, destination) {
  const target = safePath(root, destination);
  if (fs9.existsSync(target))
    throw new Error("Snapshot destination must not exist");
  const candidates = walk(root, { ignore: [".git", "node_modules", ".harness"] });
  const publicEntries = candidates.filter((e) => classify(config, e.path).audience === "public");
  const internal = internalHashes(root, config), findings = [], files = [];
  for (const file of publicEntries) {
    if (file.type !== "file") {
      findings.push(fail("path", file.path, "Public source must be a regular file"));
      continue;
    }
    const bytes = fs9.readFileSync(safePath(root, file.path)), sha256 = hash(bytes);
    if (internal.has(sha256))
      findings.push(fail("internal-copy", file.path, "Public candidate copies known internal content"));
    if (archives.test(file.path))
      findings.push(fail("archive", file.path, "Cannot export an unaudited archive"));
    findings.push(...linkFindings(root, config, file.path, bytes.toString("utf8")));
    files.push({ path: file.path, sha256, bytes });
  }
  if (!files.length)
    findings.push(fail("empty", "snapshot", "No explicitly public files to export"));
  if (findings.length)
    return report(findings);
  fs9.mkdirSync(target, { recursive: true });
  for (const file of files)
    atomicWrite(target, file.path, file.bytes);
  const manifest = { version: 1, target: "public-snapshot", artifactRoot: destination, entries: files.map(({ path: path7, sha256 }) => ({ path: path7, sha256, sources: [{ path: path7, sha256 }] })) };
  const result = checkManifest(root, config, manifest);
  return { ...result, destination, manifest, notice: "Local snapshot only. Existing target repository history must be audited separately before syncing." };
}

// src/project.mjs
import fs10 from "fs";
import path7 from "path";
function locateProject(cwd = process.cwd(), explicit) {
  if (explicit)
    return { root: fs10.realpathSync(path7.resolve(cwd, explicit)), source: "explicit" };
  const start = fs10.realpathSync(cwd), chain = [];
  let cursor = start;
  while (true) {
    chain.push(cursor);
    if (fs10.existsSync(path7.join(cursor, CONFIG)))
      return { root: cursor, source: CONFIG };
    if (fs10.existsSync(path7.join(cursor, ".git")))
      break;
    const parent = path7.dirname(cursor);
    if (parent === cursor)
      break;
    cursor = parent;
  }
  for (const dir of chain) {
    if (["pnpm-workspace.yaml", "go.work"].some((f) => fs10.existsSync(path7.join(dir, f))))
      return { root: dir, source: "workspace" };
    const pkg = path7.join(dir, "package.json");
    if (fs10.existsSync(pkg)) {
      try {
        if (JSON.parse(fs10.readFileSync(pkg, "utf8")).workspaces)
          return { root: dir, source: "workspace" };
      } catch {}
    }
  }
  const gitRoot = chain.find((dir) => fs10.existsSync(path7.join(dir, ".git")));
  if (gitRoot)
    return { root: gitRoot, source: "git" };
  const project = chain.find((dir) => ["package.json", "go.mod"].some((f) => fs10.existsSync(path7.join(dir, f))));
  return { root: project ?? start, source: project ? "project-manifest" : "current-directory" };
}

// src/interaction.mjs
import fs11 from "fs";
import { createInterface } from "readline/promises";
function terminalUI() {
  if (!process.stdin.isTTY)
    throw new Error("\u9700\u8981\u4EA4\u4E92\u7EC8\u7AEF\uFF1B\u81EA\u52A8\u5316\u8BF7\u4F7F\u7528 plan --answers \u6216 setup --answers answers.json --yes\u3002");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return { ask: (prompt) => rl.question(prompt), write: (line) => process.stderr.write(`${line}
`), close: () => rl.close() };
}
async function choose(ui, prompt, choices, defaultIndex = 0) {
  ui.write(prompt);
  choices.forEach((c, i) => ui.write(`  ${i + 1}. ${c.label}${i === defaultIndex ? "\uFF08\u9ED8\u8BA4\uFF09" : ""}`));
  while (true) {
    const raw = (await ui.ask("\u8BF7\u9009\u62E9\u5E8F\u53F7\uFF0C\u56DE\u8F66\u91C7\u7528\u9ED8\u8BA4\uFF1A")).trim();
    const index = raw === "" ? defaultIndex : Number(raw) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length)
      return choices[index].value;
    ui.write("\u8BF7\u8F93\u5165\u6709\u6548\u5E8F\u53F7\u3002");
  }
}
async function confirm(ui, prompt, { defaultYes = false } = {}) {
  while (true) {
    const value = (await ui.ask(`${prompt} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!value)
      return defaultYes;
    if (["y", "yes", "\u662F"].includes(value))
      return true;
    if (["n", "no", "\u5426"].includes(value))
      return false;
    ui.write("\u8BF7\u8F93\u5165 y \u6216 n\u3002");
  }
}
function commandArgv(input) {
  input = input.trim();
  if (input.startsWith("[")) {
    const argv2 = JSON.parse(input);
    if (!Array.isArray(argv2) || !argv2.length || argv2.some((v) => typeof v !== "string" || !v || v.includes("\x00")))
      throw new Error("\u547D\u4EE4\u6570\u7EC4\u5FC5\u987B\u5305\u542B\u975E\u7A7A\u5B57\u7B26\u4E32\u3002");
    return argv2;
  }
  const argv = [];
  let token = "", quote = null, started = false;
  for (let i = 0;i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote)
        quote = null;
      else if (c === "\\" && input[i + 1] === quote) {
        token += quote;
        i++;
      } else
        token += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
    } else if (/[|&;<>`]/.test(c) || c === "$")
      throw new Error("\u8FD9\u91CC\u4E0D\u6267\u884C shell \u7BA1\u9053\u6216\u53D8\u91CF\u5C55\u5F00\uFF0C\u8BF7\u586B\u5199\u5355\u4E2A\u7A0B\u5E8F\u547D\u4EE4\u6216\u5DF2\u6709 package script\u3002");
    else {
      token += c;
      started = true;
    }
  }
  if (quote)
    throw new Error("\u547D\u4EE4\u5F15\u53F7\u672A\u95ED\u5408\u3002");
  if (started)
    argv.push(token);
  if (!argv.length || argv.some((v) => !v || v.includes("\x00")))
    throw new Error("\u8BF7\u8F93\u5165\u53EF\u6267\u884C\u547D\u4EE4\u3002");
  return argv;
}
async function testCommand(ui, workspace) {
  const mode = await choose(ui, `\u5DE5\u4F5C\u533A ${workspace} \u7684\u6D4B\u8BD5\u5982\u4F55\u6267\u884C\uFF1F`, [
    { label: "\u8F93\u5165\u5DF2\u6709\u6D4B\u8BD5\u547D\u4EE4\uFF08\u5982 bun test \u6216 pnpm run test\uFF09", value: "custom" },
    { label: "\u6682\u4E0D\u914D\u7F6E\u6D4B\u8BD5\uFF0C\u660E\u786E\u6807\u8BB0\u672A\u914D\u7F6E", value: "none" }
  ]);
  if (mode === "none")
    return null;
  while (true) {
    try {
      return commandArgv(await ui.ask("\u6D4B\u8BD5\u547D\u4EE4\uFF1A"));
    } catch (error) {
      ui.write(error.message);
    }
  }
}
async function collectAnswers(root, answers = {}, ui, { edit = false } = {}) {
  answers = structuredClone(answers);
  if (edit) {
    const plan = makePlan(root, answers), config = JSON.parse(plan.files.find((f) => f.path === CONFIG).content);
    answers.visibility = await choose(ui, "\u4ED3\u5E93\u53EF\u89C1\u6027\uFF08\u516C\u5F00\u4ED3\u5E93\u4F1A\u68C0\u67E5\u5185\u90E8\u6587\u4EF6\u662F\u5426\u5DF2\u8DDF\u8E2A\uFF09\uFF1A", [
      { label: "\u79C1\u6709\u4ED3\u5E93", value: "private" },
      { label: "\u516C\u5F00\u4ED3\u5E93", value: "public" },
      { label: "\u6682\u4E0D\u786E\u5B9A\uFF0C\u53D1\u5E03\u95E8\u7981\u4FDD\u6301\u963B\u65AD", value: "unknown" }
    ], Math.max(0, ["private", "public", "unknown"].indexOf(config.repository.visibility)));
    for (const w of config.workspaces) {
      const existing = config.tasks.filter((t) => t.workspace === w.id && t.kind === "test");
      ui.write(`${w.id} \u5F53\u524D\u6D4B\u8BD5\uFF1A${existing.map((t) => t.argv.join(" ")).join("\uFF1B") || "\u672A\u914D\u7F6E"}`);
      if (await confirm(ui, `\u8C03\u6574 ${w.id} \u7684\u6D4B\u8BD5\u547D\u4EE4\uFF1F`))
        (answers.testCommands ??= {})[w.id] = await testCommand(ui, w.id);
    }
  }
  while (true) {
    const q = makePlan(root, answers).unanswered[0];
    if (!q)
      break;
    if (q.type === "visibility")
      answers.visibility = await choose(ui, "\u9879\u76EE\u4ED3\u5E93\u7684\u53EF\u89C1\u6027\uFF1A", [
        { label: "\u79C1\u6709\u4ED3\u5E93", value: "private" },
        { label: "\u516C\u5F00\u4ED3\u5E93", value: "public" },
        { label: "\u6682\u4E0D\u786E\u5B9A\uFF0C\u53D1\u5E03\u95E8\u7981\u4FDD\u6301\u963B\u65AD", value: "unknown" }
      ]);
    else if (q.type === "manager")
      (answers.managers ??= {})[q.workspace] = await choose(ui, `${q.workspace} \u7684\u5305\u7BA1\u7406\u5668\u5B58\u5728\u6B67\u4E49\uFF0C\u8BF7\u9009\u62E9\uFF1A`, [
        { label: "Bun", value: "bun" },
        { label: "pnpm", value: "pnpm" },
        { label: "npm", value: "npm" },
        { label: "Yarn", value: "yarn" }
      ]);
    else if (q.type === "test-command")
      (answers.testCommands ??= {})[q.workspace] = await testCommand(ui, q.workspace);
    else {
      ui.write(`\u9700\u660E\u786E\u7684\u626B\u63CF\u95EE\u9898\uFF1A${q.message}`);
      if (!await confirm(ui, "\u5DF2\u7ECF\u89E3\u51B3\u6216\u7406\u89E3\u6B64\u9879\u9650\u5236\uFF0C\u7EE7\u7EED\u751F\u6210\u8BA1\u5212\uFF1F"))
        throw new Error("\u5DF2\u505C\u6B62\u3002\u89E3\u51B3\u626B\u63CF\u95EE\u9898\u6216\u63D0\u4F9B\u663E\u5F0F\u914D\u7F6E\u540E\u91CD\u8BD5\uFF1B\u672A\u5E94\u7528\u6539\u52A8\u3002");
      (answers.acknowledge ??= []).push(q.id);
    }
  }
  return answers;
}
function previewPlan(ui, plan) {
  ui.write(`
\u53D8\u66F4\u9884\u89C8\uFF1A`);
  const labels = { create: "\u65B0\u589E", update: "\u66F4\u65B0", unchanged: "\u4E0D\u53D8", conflict: "\u51B2\u7A81\uFF0C\u4FDD\u7559\u539F\u6587\u4EF6" };
  for (const f of plan.files)
    ui.write(`  ${labels[f.action]}  ${f.path}`);
  const config = JSON.parse(plan.files.find((f) => f.path === CONFIG).content);
  ui.write(`  \u4ED3\u5E93\uFF1A${config.repository.visibility}\uFF1B\u5DE5\u4F5C\u533A\uFF1A${config.workspaces.map((w) => w.id).join("\u3001")}`);
  for (const task of config.tasks)
    ui.write(`  ${task.workspace}/${task.id}: ${task.argv.join(" ")}`);
  ui.write("  \u5185\u90E8 memory / decision \u4E0D\u516C\u5F00\uFF1B\u4FDD\u7559\u6D4B\u8BD5\u6846\u67B6\u539F\u6709\u5E03\u5C40\u3002");
}
async function setup(root, { answers = {}, yes = false, ui, out = ".harness/plan.json" } = {}) {
  if (!yes && !ui)
    throw new Error("\u4EA4\u4E92\u8F93\u5165\u4E0D\u53EF\u7528\uFF1B\u8BF7\u63D0\u4F9B\u7B54\u6848\u6587\u4EF6\u5E76\u663E\u5F0F\u4F7F\u7528 --yes\u3002");
  if (ui) {
    const existing = fs11.existsSync(safePath(root, CONFIG));
    const edit = existing && await choose(ui, "\u9879\u76EE\u5DF2\u6709\u914D\u7F6E\uFF1A", [
      { label: "\u4FDD\u7559\u5DF2\u6709\u8BBE\u7F6E\uFF0C\u68C0\u67E5\u751F\u6210\u5DEE\u5F02", value: false },
      { label: "\u8C03\u6574\u4ED3\u5E93\u53EF\u89C1\u6027\u548C\u6D4B\u8BD5\u547D\u4EE4", value: true }
    ]);
    answers = await collectAnswers(root, answers, ui, { edit });
  }
  const plan = makePlan(root, answers);
  if (plan.unanswered.length)
    throw new Error("\u8FD8\u6709\u672A\u56DE\u7B54\u7684\u95EE\u9898\u3002\u8BF7\u8FD0\u884C harness \u4EA4\u4E92\u914D\u7F6E\uFF0C\u6216\u8865\u5168 --answers \u6587\u4EF6\u3002");
  if ([...managedPaths, ".harness/managed.json"].includes(relativePath(out)))
    throw new Error("\u8BA1\u5212\u8F93\u51FA\u4E0D\u80FD\u8986\u76D6\u9879\u76EE\u53D7\u7BA1\u7406\u6587\u4EF6\u6216\u751F\u6210\u72B6\u6001\u3002");
  atomicWrite(root, out, json(plan));
  ui?.write(`\u5B8C\u6574\u8BA1\u5212\u5DF2\u4FDD\u5B58\uFF1A${safePath(root, out)}`);
  if (ui)
    previewPlan(ui, plan);
  const action = yes ? "apply" : await choose(ui, "\u4E0B\u4E00\u6B65\uFF1A", [
    { label: "\u5E94\u7528\u5B89\u5168\u53D8\u66F4\uFF0C\u51B2\u7A81\u6587\u4EF6\u4FDD\u7559", value: "apply" },
    { label: "\u53EA\u4FDD\u5B58\u8BA1\u5212\uFF0C\u7A0D\u540E\u5E94\u7528", value: "save" },
    { label: "\u5148\u67E5\u770B\u5B8C\u6574\u5EFA\u8BAE\u6587\u4EF6\u5185\u5BB9", value: "view" }
  ], 1);
  let apply = action === "apply";
  if (action === "view") {
    for (const file of plan.files)
      if (file.action !== "unchanged")
        ui.write(`
--- ${file.path} (${file.action}) ---
${file.content}`);
    apply = await confirm(ui, "\u5E94\u7528\u4E0A\u8FF0\u5B89\u5168\u53D8\u66F4\uFF1F");
  }
  if (!apply)
    return { status: "planned", exitCode: 0, plan: out, root };
  const result = applyPlan(root, plan);
  ui?.write(result.conflicts.length ? "\u5DF2\u5E94\u7528\u5B89\u5168\u53D8\u66F4\u3002\u51B2\u7A81\u6587\u4EF6\u539F\u6837\u4FDD\u7559\uFF0C\u8BF7\u5BF9\u7167\u8BA1\u5212\u5408\u5E76\u3002" : "\u914D\u7F6E\u5DF2\u5B8C\u6210\u3002\u4E0B\u4E00\u6B21\u53EF\u76F4\u63A5\u8FD0\u884C harness lint \u6216 harness verify\u3002");
  return { ...result, plan: out, root };
}

// src/cli.mjs
var HELP = `Harness Kit (Bun) \u2014 project conventions and publication governance

Usage: harness [command] [options]
\u76F4\u63A5\u5728\u9879\u76EE\u4E2D\u8FD0\u884C harness \u6253\u5F00\u4E2D\u6587\u83DC\u5355\uFF1B\u81EA\u52A8\u8BC6\u522B\u9879\u76EE\u6839\u76EE\u5F55\uFF0C\u65E0\u9700\u586B\u5199\u5DE5\u5177\u8DEF\u5F84\u3002
setup [--answers file --yes]     \u4EA4\u4E92\u521D\u59CB\u5316/\u8C03\u6574\u914D\u7F6E\u3001\u9884\u89C8\u5E76\u5E94\u7528\uFF08\u9ED8\u8BA4\u4FDD\u5B58 .harness/plan.json\uFF09

inspect                         Static discovery, evidence and missing questions
configure [--answers file]       Ask missing questions and emit a plan (no apply)
plan [--answers file]            Emit a reviewable plan and full proposed content
apply --plan file                Apply an unchanged reviewed plan; preserve conflicts
lint                            Read-only governance checks, including public Git index
verify [--task id]               Lint plus configured task DAG, one execution per task
baseline                        Emit ordinary findings as baseline fingerprints
publication-check [--target id | --manifest file]
                                Check actual output tree and reviewed source provenance
export --destination path [--manifest-out file]
                                Export public snapshot to NEW local directory, no history
audit-history [--evidence file]  Reachable Git history and reviewer-attested platform scope
review-template                 Emit evidence template bound to current refs and policy

Shared: --root project (optional override), --json (machine output), --out relative-file.
All file options except --root are relative to the project. No install, upload or push.
`;
function parse(args) {
  const command = args[0]?.startsWith("--") ? "menu" : args.shift() ?? "menu", options = {};
  const switches = new Set(["json", "help", "yes"]);
  const allowed = new Set(["root", "answers", "out", "plan", "task", "target", "manifest", "destination", "manifest-out", "evidence", ...switches]);
  while (args.length) {
    const arg = args.shift();
    if (!arg.startsWith("--") || !allowed.has(arg.slice(2)))
      throw new Error(`Unknown argument: ${arg}`);
    const key = arg.slice(2);
    if (Object.hasOwn(options, key))
      throw new Error(`Duplicate option: ${arg}`);
    if (switches.has(key))
      options[key] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value: ${arg}`);
      options[key] = value;
    }
  }
  const perCommand = { menu: [], setup: ["answers", "yes"], inspect: [], configure: ["answers"], plan: ["answers"], apply: ["plan"], lint: [], verify: ["task"], baseline: [], "publication-check": ["target", "manifest"], export: ["destination", "manifest-out"], "audit-history": ["evidence"], "review-template": [], help: [] };
  if (!Object.hasOwn(perCommand, command))
    throw new Error(`Unknown command: ${command}`);
  for (const key of Object.keys(options))
    if (!["root", "out", "json", "help", ...perCommand[command]].includes(key))
      throw new Error(`Option --${key} is not valid for ${command}`);
  return { command, options };
}
async function ask(root, answers) {
  if (!makePlan(root, answers).unanswered.length)
    return answers;
  const ui = terminalUI();
  try {
    return await collectAnswers(root, answers, ui);
  } finally {
    ui.close();
  }
}
function printResult(command, result, options) {
  if (options.json) {
    console.log(json(result));
    return;
  }
  console.log(`${command}: ${result.status ?? "ready"}${options.out ? `\uFF08\u5DF2\u4FDD\u5B58 ${options.out}\uFF09` : ""}`);
  if (result.root)
    console.log(`\u9879\u76EE\uFF1A${result.root}`);
  if (result.plan)
    console.log(`\u8BA1\u5212\uFF1A${result.plan}`);
  for (const name of result.changed ?? [])
    console.log(`\u5DF2\u66F4\u65B0\uFF1A${name}`);
  for (const name of result.conflicts ?? [])
    console.log(`\u4FDD\u7559\u51B2\u7A81\uFF1A${name}`);
  if (result.suggestedConfig) {
    console.log(`\u5DE5\u4F5C\u533A\uFF1A${result.suggestedConfig.workspaces.map((w) => w.id).join("\u3001")}`);
    for (const f of result.facts ?? [])
      console.log(`\u53D1\u73B0\uFF1A${f.source} \u2192 ${f.capability}`);
    for (const q of result.questions ?? [])
      console.log(`\u5F85\u660E\u786E\uFF1A${q.message}`);
  }
  for (const f of [...result.findings ?? [], ...result.governance?.findings ?? []])
    console.log(`[${f.severity}] ${f.path}: ${f.message}`);
  for (const t of result.verification?.tasks ?? []) {
    console.log(`${t.status} ${t.id}${t.reason ? ` (${t.reason})` : ""}`);
    if (t.status !== "passed" && t.output)
      console.log(t.output);
  }
  for (const w of result.workspaces ?? result.verification?.workspaces ?? [])
    console.log(`\u5DE5\u4F5C\u533A ${w.id}\uFF1A${w.tests ?? w.status}`);
  if (["plan", "configure", "baseline", "review-template", "export", "publication-check", "audit-history"].includes(command))
    console.log(json(result));
}
async function main(argv) {
  let options = {};
  try {
    const parsed = parse([...argv]);
    options = parsed.options;
    let { command } = parsed;
    if (command === "help" || options.help) {
      console.log(HELP);
      return 0;
    }
    if (command === "menu" && !process.stdin.isTTY) {
      console.log(options.json ? json({ status: "ready", interactive: false, message: "\u5728\u4EA4\u4E92\u7EC8\u7AEF\u8FD0\u884C harness\uFF0C\u6216\u4F7F\u7528 inspect / setup --answers answers.json --yes / lint / verify\u3002" }) : HELP);
      return 0;
    }
    const project = locateProject(process.cwd(), options.root), root = project.root;
    if (!options.json)
      console.log(`\u9879\u76EE\uFF1A${root}\uFF08${project.source}\uFF09`);
    if (command === "menu") {
      const ui = terminalUI();
      try {
        command = await choose(ui, "\u60F3\u505A\u4EC0\u4E48\uFF1F", [
          { label: fs12.existsSync(path8.join(root, "harness.config.json")) ? "\u68C0\u67E5\u6216\u8C03\u6574\u9879\u76EE\u914D\u7F6E" : "\u521D\u59CB\u5316\u9879\u76EE\u7EA6\u675F", value: "setup" },
          { label: "\u67E5\u770B\u626B\u63CF\u7ED3\u679C\uFF0C\u4E0D\u4FEE\u6539\u6587\u4EF6", value: "inspect" },
          { label: "\u68C0\u67E5\u9879\u76EE\u7EA6\u5B9A\uFF08lint\uFF09", value: "lint" },
          { label: "\u8FD0\u884C\u7EA6\u5B9A\u68C0\u67E5\u548C\u6D4B\u8BD5\uFF08verify\uFF09", value: "verify" },
          { label: "\u9000\u51FA", value: "exit" }
        ]);
      } finally {
        ui.close();
      }
      if (command === "exit")
        return 0;
    }
    if (process.env.HARNESS_ACTIVE && ["verify", "lint", "setup"].includes(command))
      throw new Error("Recursive harness invocation refused");
    const requireOption = (key) => {
      if (!options[key])
        throw new Error(`--${key} is required`);
      return options[key];
    };
    let result;
    if (command === "setup") {
      if (options.json && !options.yes)
        throw new Error("\u673A\u5668\u6A21\u5F0F setup \u9700\u8981 --answers \u6587\u4EF6\u4E0E --yes\uFF1B\u4EA4\u4E92\u4F7F\u7528 harness \u6216 harness setup\u3002");
      const answers = options.answers ? readJson(root, options.answers) : {};
      const ui = options.yes ? null : terminalUI();
      try {
        result = await setup(root, { answers, yes: options.yes, ui, out: options.out ?? ".harness/plan.json" });
      } finally {
        ui?.close();
      }
    } else if (command === "inspect")
      result = { ...inspect(root), root };
    else if (command === "plan" || command === "configure") {
      let answers = options.answers ? readJson(root, options.answers) : {};
      if (command === "configure")
        answers = await ask(root, answers);
      result = makePlan(root, answers);
    } else if (command === "apply")
      result = applyPlan(root, readJson(root, requireOption("plan")));
    else {
      const config = loadConfig(root);
      if (command === "lint")
        result = lint(root, config);
      else if (command === "baseline") {
        const check = lint(root, config, { useBaseline: false });
        result = { baseline: check.findings.filter((f) => !f.protected).map((f) => f.fingerprint), excludedProtected: check.findings.filter((f) => f.protected).length, notice: "Review and merge baseline into harness.config.json; nothing changed automatically." };
      } else if (command === "verify") {
        const governance = lint(root, config), controller = new AbortController;
        const abort = () => controller.abort();
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
          const verification = await verify(root, config, { selected: options.task ? [options.task] : undefined, signal: controller.signal });
          const exitCode = Math.max(governance.exitCode, verification.exitCode);
          result = { status: exitCode ? "failed" : verification.status, exitCode, governance, verification };
        } finally {
          process.removeListener("SIGINT", abort);
          process.removeListener("SIGTERM", abort);
        }
      } else if (command === "publication-check")
        result = publicationCheck(root, config, { target: options.target, manifestPath: options.manifest });
      else if (command === "export") {
        result = exportSnapshot(root, config, requireOption("destination"));
        if (result.manifest && options["manifest-out"])
          atomicWrite(root, options["manifest-out"], json(result.manifest));
      } else if (command === "review-template")
        result = reviewTemplate(root, config);
      else if (command === "audit-history")
        result = auditHistory(root, config, { evidence: options.evidence ? readJson(root, options.evidence) : undefined, onProgress: options.json ? undefined : (p) => {
          if (p.current === 1 || p.current % 20 === 0 || p.current === p.total)
            process.stderr.write(`history ${p.current}/${p.total}
`);
        } });
    }
    if (options.out && command !== "setup")
      atomicWrite(root, options.out, json(result));
    printResult(command, result, options);
    return result.exitCode ?? 0;
  } catch (error) {
    console.error(json({ status: "error", exitCode: 2, message: error.message }));
    return 2;
  }
}

// bin/harness.mjs
if (!globalThis.Bun) {
  console.error("Harness Kit requires Bun >= 1.3.4. Run: bun bin/harness.mjs");
  process.exitCode = 2;
} else
  process.exitCode = await main(process.argv.slice(2));
