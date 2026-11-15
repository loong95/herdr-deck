// Drives the review tab outside Herdr: what it asks glab for, what it puts in the file
// list, and what a confirmed dialog finally runs. Nothing here talks to GitLab, so no MR
// is ever merged or closed by this test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.MODS_HOME ?? ROOT;
const MOD = `${HOME}/mods/mr-review/main.js`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-mod-harness-"));

const STUBS = `
const View = class {};
const el = () => new Proxy({}, { get: (t, k) => (k === "then" ? undefined : () => el()), set: () => true });
const div = el, h_flex = el, v_flex = el, svg = () => el();
const v_virtual_list = el, Input = el, InputState = { new: () => ({}) };
const Scrollbar = { vertical: () => el() };
globalThis.localStorage = { getItem: (k) => globalThis.__ls[k] ?? null, setItem: (k, v) => { globalThis.__ls[k] = v; } };
const exec = async (cmd, args, opts) => { globalThis.__calls.push({ cmd, args, opts }); return globalThis.__reply(cmd, args, opts); };
const run = (name, args) => { globalThis.__runs.push([name, args]); return null; };
const openOverlay = (spec) => { globalThis.__overlays.push(spec); return "o1"; };
const closeOverlay = () => null;
const shared = (k) => globalThis.__shared[k];
const setShared = (k, v) => { globalThis.__shared[k] = v; };
const props = () => globalThis.__props ?? {};
const settings = () => ({});
const theme = () => ({ background: "#000", chrome: "#000", border: "#111", foreground: "#eee", muted: "#888", dim: "#666", raised: "#222", hover: "#333", selected: "#444", solid: "#555", solid_foreground: "#fff", accent: "#7af", blocked: "#f00", done: "#0f0", working: "#ff0", ansi1: "#f55", ansi2: "#5f5" });
// A broadcast: every copy of the mod wakes up on the command, whichever one the app
// would really have picked, so the copies have to sort among themselves who acts.
const __waiters = [];
const nextCommand = () => new Promise((res) => { __waiters.push(res); });
globalThis.__send = (c) => __waiters.splice(0, __waiters.length).forEach((res) => res(c));
globalThis.__only = () => { __waiters.length = 0; };
globalThis.__ls = {};
`;

let n = 0;
async function loadMod(file, names) {
  let src = fs.readFileSync(file, "utf8").replace(/^import .*$/gm, "").replace("export default class", "class");
  src += `\nglobalThis.__X = { ${names.join(", ")} };\n`;
  const tmp = `${SCRATCH}/harness-${n++}.mjs`;
  fs.writeFileSync(tmp, STUBS + src);
  await import("file:///" + tmp.replace(/\\/g, "/"));
  return globalThis.__X;
}

const PROJECT = "acme/team/trunk/db";
const SQL = "install/nacos脚本/install_c3i_nacos.sql";
// The octal form is what git really prints for a path it will not put out raw.
const QUOTED = '"a/install/nacos\\350\\204\\232\\346\\234\\254/install_c3i_nacos.sql"';

const meta = (over = {}) => ({
  iid: 3, title: "编辑install_c3i_nacos.sql", state: "opened", detailed_merge_status: "mergeable",
  source_branch: "author-patch", target_branch: "main", web_url: "https://gitlab.example.com/x/-/merge_requests/3",
  author: { username: "author", name: "Author Name" }, updated_at: new Date(Date.now() - 40 * 60e3).toISOString(),
  ...over,
});

const oneDiff = (over = {}) => ({
  new_path: SQL, old_path: SQL, diff: "@@ -4377,6 +4377,8 @@ cinterface\n keep\n-old\n+new\n+new2\n", ...over,
});

const RAW = [
  `diff --git ${QUOTED} ${QUOTED.replace('"a/', '"b/')}`,
  "index 3e42510..d9ea74b 100644",
  `--- ${QUOTED}`,
  `+++ ${QUOTED.replace('"a/', '"b/')}`,
  "@@ -4377,6 +4377,8 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/x b/x",
  "deleted file mode 100644",
  "--- a/x",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-a",
  "-b",
  "",
].join("\n");

let diffState = { meta: meta(), files: [oneDiff()], fail: false };
globalThis.__calls = [];
globalThis.__runs = [];
globalThis.__overlays = [];
globalThis.__shared = {};
globalThis.__props = {};
globalThis.__reply = async (cmd, args) => {
  const ep = String(args.at(-1));
  if (args[0] === "api") return { code: 0, stdout: JSON.stringify(ep.includes("/diffs") ? diffState.files : diffState.meta), stderr: "" };
  if (args[1] === "diff") return { code: 0, stdout: RAW, stderr: "" };
  if (args[0] === "mr") return diffState.fail
    ? { code: 1, stdout: "", stderr: "  ERROR  \n  glab: 405 Method Not Allowed (HTTP 405)\n  Try --help for usage.\n" }
    : { code: 0, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};
const reset = () => { globalThis.__calls = []; globalThis.__overlays = []; globalThis.__shared = {}; };
const asked = (want) => globalThis.__calls.map((c) => c.args).filter((a) => want.every((x, i) => a[i] === x)).length;
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const cx = {
  notify: () => {},
  focus_handle: () => ({}),
  spawn: (fn) => fn(cx),
  timer: { every: () => ({}), after: (ms, fn) => { setTimeout(() => fn(cx), ms); return {}; } },
};

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`ok   ${label}`);
  else { fails.push(label); console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

const { MrReview, enc, unquote, chunks, fileOf, say, tint, splitRows, treeRows, mdLines } =
  await loadMod(MOD, ["MrReview", "enc", "unquote", "chunks", "fileOf", "say", "tint", "splitRows", "treeRows", "mdLines"]);

// --- the pure helpers ---
eq("enc 把仓库路径编成项目端点要的写法", enc(PROJECT), "acme%2Fteam%2Ftrunk%2Fdb");
eq("unquote 还原 git 八进制转义的中文路径", unquote(QUOTED), "a/" + SQL);
eq("unquote 不动普通路径", unquote("b/deploy/docker-compose.yml"), "b/deploy/docker-compose.yml");
eq("chunks 按 +++ 认文件，删掉的改按 ---", [...chunks(RAW).keys()], [SQL, "x"]);
eq("chunks 只留 @@ 往下的正文", chunks(RAW).get("x").split("\n")[0], "@@ -1,2 +0,0 @@");
eq("chunks 把补丁头甩掉", chunks(RAW).get(SQL).includes("index 3e42510"), false);
eq("fileOf 数出入行数", fileOf(oneDiff(), 0), { n: 0, path: SQL, status: "M", add: 2, del: 1, diff: oneDiff().diff, folded: false });
eq("fileOf 认新增/删除/改名/二进制", [
  fileOf({ new_path: "a", new_file: true, diff: "@@ -0,0 +1,1 @@\n+z" }, 0).status,
  fileOf({ new_path: "a", deleted_file: true, diff: "@@ -1 +0,0 @@\n-z" }, 0).status,
  fileOf({ new_path: "b", old_path: "a", renamed_file: true, diff: "" }, 0).status,
  fileOf({ new_path: "b", diff: "" }, 0).status,
], ["A", "D", "R", "B"]);
eq("fileOf 认得出被 GitLab 折起的那类", [
  fileOf({ new_path: "b", diff: "", collapsed: true }, 0).folded,
  fileOf({ new_path: "b", diff: "", too_large: true }, 0).folded,
  fileOf({ new_path: "b", diff: "" }, 0).folded,
], [true, true, false]);
eq("say 剥掉 glab 的框和 HTTP 码", say("  ERROR  \n  glab: 405 Method Not Allowed (HTTP 405)\n  Try --help for usage.\n"), "405 Method Not Allowed");
eq("暗底子上差异色要压得更实", [
  tint({ background: "#0d1117", foreground: "#e6edf3" }),
  tint({ background: "#f6f8fa", foreground: "#1f2328" }),
], ["3a", "18"]);

// --- 并排：删的一串和加的一串对起来读，短的那边留空 ---
const SPLIT = ["@@ -1,4 +1,5 @@", " keep", "-a", "-b", "+x", "+y", "+z", " tail"];
eq("并排的行型", splitRows(SPLIT).map((r) => r.kind), ["@", "=", "x", "x", "x", "="]);
eq("并排两边的行号各走各的", splitRows(SPLIT).slice(2, 5).map((r) => [r.left?.number ?? null, r.right?.number ?? null]), [[2, 2], [3, 3], [null, 4]]);
eq("并排只数真存在的行", splitRows(SPLIT).at(-1), { kind: "=", left: { kind: " ", number: 4, text: "tail" }, right: { kind: " ", number: 5, text: "tail" } });
eq("并排把行号从 +/- 摘掉", splitRows(SPLIT)[2].left.text, "a");

// --- 树：只有一个孩子的目录链折成一行 ---
const TREE = [
  { path: "src/main/java/com/x/App.java", n: 0 },
  { path: "src/main/java/com/x/util/Log.java", n: 1 },
  { path: "pom.xml", n: 2 },
];
eq("树的形状", treeRows(TREE, new Set()).map((r) => [r.type, r.name, r.depth]), [
  ["dir", "src/main/java/com/x", 0],
  ["dir", "util", 1],
  ["file", "Log.java", 2],
  ["file", "App.java", 1],
  ["file", "pom.xml", 0],
]);
eq("关掉一个目录就只剩它自己", treeRows(TREE, new Set(["src/main/java/com/x"])).map((r) => [r.type, r.name]), [["dir", "src/main/java/com/x"], ["file", "pom.xml"]]);

// --- 说明：GitLab 给的是 markdown，这里只认行首那几样 ---
const MD = ["## 改了什么", "", "- [x] 已完成的事", "- [ ] 还没做", "  - 缩进的子项", "1. 第一条", "> 引用一句", "带 `代码` 和 [链接](http://a.b) 的句子", "", "```yaml", "key: value", "```", "| 列 | 二 |"].join("\n");
eq("说明按行认得出结构", mdLines(MD).map((l) => l.kind), ["head", "gap", "check", "check", "li", "li", "quote", "p", "gap", "code", "code"]);
eq("勾选项分得清做完没做", mdLines(MD).filter((l) => l.kind === "check").map((l) => l.done), [true, false]);
eq("行内标记只留文字", mdLines(MD).find((l) => l.kind === "p").text, "带 代码 和 链接 http://a.b 的句子");
eq("缩进过的子项记着层数", mdLines(MD).filter((l) => l.kind === "li").map((l) => [l.depth, l.text]), [[1, "- 缩进的子项"], [0, "1. 第一条"]]);

// --- 打开一个评审：问什么、先摆什么 ---
reset();
globalThis.__only();
globalThis.__props = { iid: "3", path: PROJECT, on: "wsl" };
const r = new MrReview();
r.init({}, cx);
await settle();
eq("问的是 space 那台机器上的 glab", globalThis.__calls.map((c) => c.opts.on), ["wsl", "wsl"]);
eq("开一次问两样", globalThis.__calls.map((c) => c.args.at(-1)), [
  `projects/${enc(PROJECT)}/merge_requests/3`,
  `projects/${enc(PROJECT)}/merge_requests/3/diffs?per_page=100`,
]);
eq("文件多也拿得全：diffs 用 --paginate", globalThis.__calls[1].args, ["api", "--paginate", `projects/${enc(PROJECT)}/merge_requests/3/diffs?per_page=100`]);
eq("第一个文件的差异先摆出来，跟 Changes 一样", r.open, SQL);
eq("行号数对了", r.rows.map((x) => x.number ?? "-"), ["-", 4377, 4378, 4378, 4379]);
eq("标题、GitLab 的判断、能不能合并", [r.meta.title, r.verdict().status, r.verdict().canMerge], ["编辑install_c3i_nacos.sql", "可合并", true]);

diffState.meta = meta({ description: "## 为什么\n\n- 一条理由\n" });
r.load(cx); await settle();
eq("说明跟着 meta 一起解析好", r.desc.map((l) => l.kind), ["head", "gap", "li"]);
diffState.meta = meta();
r.load(cx); await settle();
eq("没有说明就没有内容可展开", r.desc.length, 0);

r.busy = true;
eq("正在动手时不给再点", r.verdict().canMerge, false);
r.busy = false;
diffState.meta = meta({ detailed_merge_status: "conflict" });
r.load(cx); await settle();
eq("有冲突时不能合并", r.verdict().canMerge, false);
eq("有冲突时仍然可以关闭", r.verdict().live, true);
diffState.meta = meta({ state: "merged", detailed_merge_status: "not_open" });
r.load(cx); await settle();
eq("已经合上了，两个按钮都不给点", [r.verdict().live, r.verdict().canMerge], [false, false]);
diffState.meta = meta();

// --- 被 GitLab 折起来的文件改问整份补丁，而且只问一次 ---
reset();
globalThis.__only();
diffState.files = [oneDiff({ collapsed: true, diff: "" })];
const f2 = new MrReview();
f2.init({}, cx);
await settle();
eq("折起来的文件在第一次打开时就去要整份补丁", globalThis.__calls.map((c) => c.args).filter((a) => a[1] === "diff"),
  [["mr", "diff", "3", "-R", PROJECT, "--raw", "--color=never"]]);
eq("整份补丁里的 hunk 摆出来了", f2.rows.filter((x) => x.kind === "+").length, 1);
reset();
await f2.show(SQL);
eq("整份补丁只取一次", globalThis.__calls.length, 0);
diffState.files = [oneDiff()];

// --- 二次确认：先弹内置 dialog，点了确认才动手 ---
reset();
globalThis.__only();
const p = new MrReview();
p.init({}, cx);
await settle();
p.ask("merge");
const pending = () => globalThis.__shared["mr-review.pending"];
eq("确认前先把要动的 MR 记下", (({ kind, iid, path }) => ({ kind, iid, path }))(pending()), { kind: "merge", iid: "3", path: PROJECT });
eq("弹的是内置 confirm", globalThis.__overlays.map((o) => [o.mod, o.kind, o.props.title]), [["confirm", "dialog", "合并 !3？"]]);
eq("确认框里说清自动合并这件事", globalThis.__overlays[0].props.detail.includes("自动合并"), true);
eq("它只让回一个命令名", globalThis.__overlays[0].props.command, { name: "mr-review.confirm" });
globalThis.__send("confirm");
await settle();
eq("点了确认才发 mr merge -y", globalThis.__calls.map((c) => c.args).filter((a) => a[1] === "merge"), [["mr", "merge", "3", "-R", PROJECT, "-y"]]);
eq("动手也走同一台机器", globalThis.__calls.find((c) => c.args[1] === "merge").opts.on, "wsl");
eq("领完就把这份活清掉", pending(), null);

// --- 几个副本同时醒来也只有一个动手 ---
reset();
globalThis.__only();
const two = [new MrReview(), new MrReview()];
two.forEach((x) => x.init({}, cx));
await settle();
two[0].ask("merge");
globalThis.__send("confirm");
await settle();
eq("两个副本只有一个动手", asked(["mr", "merge"]), 1);
eq("另一个看到活被领走了", pending(), null);

// --- 关闭：话要说两样，命令也不一样 ---
reset();
globalThis.__only();
const c = new MrReview();
c.init({}, cx);
await settle();
c.ask("close");
eq("关闭另说一句", [globalThis.__overlays[0].props.title, globalThis.__overlays[0].props.detail.includes("reopen")], ["关闭 MR !3？", true]);
globalThis.__send("mr-review.confirm");
await settle();
eq("关闭发 mr close（没有 -y）", globalThis.__calls.map((x) => x.args).filter((a) => a[0] === "mr"), [["mr", "close", "3", "-R", PROJECT]]);

// 过期没人领的活，不能凭一次按键再翻出来
globalThis.__shared["mr-review.pending"] = { kind: "merge", iid: "3", path: PROJECT, at: Date.now() - 600000 };
globalThis.__send("confirm");
await settle();
eq("太旧的确认不算数", asked(["mr", "merge"]), 0);
eq("太旧的活没人领就不清", globalThis.__shared["mr-review.pending"].kind, "merge");

// glab 拒绝时把原因显示出来，别把面板卡在半路上
diffState.fail = true;
reset();
globalThis.__only();
const g = new MrReview();
g.init({}, cx);
await settle();
g.ask("merge");
globalThis.__send("confirm");
await settle();
eq("失败时把 glab 的话剥干净", g.note, "合并没做成：405 Method Not Allowed");
eq("失败后不 busy，也刷新过了", [g.busy, g.meta.title], [false, "编辑install_c3i_nacos.sql"]);
diffState.fail = false;

// --- 视图选择放在 shared 里：第二个评审 tab 打开就是同一个样子 ---
reset();
globalThis.__only();
globalThis.__props = { iid: "3", path: PROJECT, on: "wsl" };
const v1 = new MrReview();
v1.init({}, cx);
await settle();
eq("默认是平铺列表 + 单栏差异 + 说明收起", [v1.view("files"), v1.view("diff"), v1.view("desc")], ["flat", "unified", false]);
v1.setView("files", "tree");
v1.setView("desc", true);
const v2 = new MrReview();
v2.init({}, cx);
await settle();
eq("新 tab 沿用同一套选择", [v2.view("files"), v2.view("diff"), v2.view("desc")], ["tree", "unified", true]);
eq("写出去的是完整一份", globalThis.__shared["mr-review.view"], { files: "tree", diff: "unified", desc: true });

// --- 没有 props 时（herdr-app check 就是这么跑的）不去敲 glab ---
reset();
globalThis.__only();
globalThis.__props = {};
const q = new MrReview();
q.init({}, cx);
await settle();
eq("没给 MR 就不问", globalThis.__calls.length, 0);

console.log(fails.length ? `\n${fails.length} failed: ${fails.join(", ")}` : "\nall ok");
process.exit(fails.length ? 1 : 0);
