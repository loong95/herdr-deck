// Drives the review tab outside Herdr: what it asks glab for, what it puts in the file
// list, and what a confirmed dialog finally runs. Nothing here talks to GitLab, so no MR
// is ever merged or closed by this test.
//
// The modules the mod imports come from test/stub/ (see stub/register.mjs): this is the real
// source, imported as it is.
import { fake, log } from "./stub/herdr.mjs";
import { byId, textOf } from "./stub/element.mjs";
import MrReview, {
  enc, unquote, chunks, fileOf, say, tint, splitRows, treeRows, mdLines, mdInline, markDone,
  pipelineOf, talkRows,
} from "../mods/mr-review/main.js";

// The app hands a command to every copy of a mod, whichever one it would really have picked,
// so the copies have to sort among themselves who acts. __send delivers one; __only drops the
// ones still waiting.
const waiters = [];
globalThis.__nextCommand = () => new Promise((res) => { waiters.push(res); });
globalThis.__send = (c) => waiters.splice(0, waiters.length).forEach((res) => res(c));
globalThis.__only = () => { waiters.length = 0; };
globalThis.__ls = {};
fake.props = {};

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

// What glab answers for the two extras. Empty by default: a review of an MR nobody has
// commented on and whose project runs no pipeline is the ordinary case.
let diffState = { meta: meta(), files: [oneDiff()], fail: false, pipes: [], talk: [] };
globalThis.__calls = [];
globalThis.__runs = [];
globalThis.__overlays = [];
globalThis.__shared = {};
globalThis.__props = {};
globalThis.__opened = [];
globalThis.__reply = async (cmd, args) => {
  const ep = String(args.at(-1));
  if (args[0] === "api") {
    if (diffState.extraFail && (ep.includes("/pipelines") || ep.includes("/discussions"))) {
      return { code: 1, stdout: "", stderr: "  ERROR  \n  glab: 404 Not Found (HTTP 404)\n" };
    }
    const body = ep.includes("/diffs") ? diffState.files
      : ep.includes("/pipelines") ? diffState.pipes
      : ep.includes("/discussions") ? diffState.talk
      : diffState.meta;
    return { code: 0, stdout: JSON.stringify(body ?? null), stderr: "" };
  }
  if (args[1] === "diff") return { code: 0, stdout: RAW, stderr: "" };
  if (args[0] === "mr") return diffState.fail
    ? { code: 1, stdout: "", stderr: "  ERROR  \n  glab: 405 Method Not Allowed (HTTP 405)\n  Try --help for usage.\n" }
    : { code: 0, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};
const reset = () => { globalThis.__calls = []; globalThis.__overlays = []; globalThis.__shared = {}; globalThis.__opened = []; };
const asked = (want) => globalThis.__calls.map((c) => c.args).filter((a) => want.every((x, i) => a[i] === x)).length;
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const cx = {
  notify: () => {},
  focus_handle: () => ({}),
  spawn: (fn) => fn(cx),
  timer: { every: () => ({}), after: (ms, fn) => { setTimeout(() => fn(cx), ms); return {}; } },
  // App::open_url, as a click handler is handed it: the pipeline chip's way into GitLab.
  open_url: (url) => globalThis.__opened.push(url),
};

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`ok   ${label}`);
  else { fails.push(label); console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};


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

// --- 流水线：最新的一条，和它的入口 ---
const PIPE = (over = {}) => ({
  id: 91, status: "success", sha: "0123456789abcdef", ref: "author-patch",
  updated_at: new Date(Date.now() - 5 * 60e3).toISOString(),
  web_url: "https://gitlab.example.com/x/-/pipelines/91", ...over,
});
eq("流水线取最新的一条", [pipelineOf([PIPE(), PIPE({ id: 90, status: "failed" })]).id, pipelineOf([PIPE()]).status], [91, "success"]);
eq("流水线的状态说成人话", [
  pipelineOf([PIPE({ status: "failed" })]).label,
  pipelineOf([PIPE({ status: "running" })]).label,
  pipelineOf([PIPE({ status: "manual" })]).label,
  pipelineOf([PIPE({ status: "waiting_for_resource" })]).label,
], ["流水线失败", "流水线在跑", "流水线待手动", "流水线等资源"]);
eq("通过和失败用的不是同一个颜色位", [pipelineOf([PIPE()]).tone, pipelineOf([PIPE({ status: "failed" })]).tone], ["done", "blocked"]);
eq("没跑过流水线就什么都不说", [pipelineOf([]), pipelineOf(null)], [null, null]);
eq("不认识的状也照样说出来，总比留一片空白好", pipelineOf([PIPE({ status: "wibble" })]).label, "流水线 wibble");

// --- 讨论：一条评论一行，回复跟在自己那句下面，系统事件单独标出来 ---
const at = (min) => new Date(Date.now() - min * 60e3).toISOString();
const NOTE = (over = {}) => ({ id: 1, body: "一句", author: { name: "Ann" }, created_at: at(60), ...over });
const TALKS = [
  { notes: [NOTE({ id: 1, body: "第一句", created_at: at(50) }), NOTE({ id: 2, body: "回一句", author: { username: "bob" }, created_at: at(40) })] },
  { notes: [NOTE({ id: 3, system: true, body: "changed the description", created_at: at(30) })] },
  { notes: [NOTE({ id: 4, body: "这一行有问题", created_at: at(20), resolvable: true, resolved: false, position: { new_path: "a/b.sql", new_line: 12 } })] },
];
eq("按说话的先后排，回复在哪句之后", talkRows(TALKS).map((n) => n.id), ["n1", "n2", "n3", "n4"]);
eq("系统事件标出来，正文压成一行", (({ system, plain }) => ({ system, plain }))(talkRows(TALKS)[2]), { system: true, plain: "changed the description" });
eq("没写名字就用账号", talkRows(TALKS)[1].who, "bob");
eq("讨论挂在哪一行", talkRows(TALKS)[3].where, "a/b.sql:12");
eq("能解决的说明解决到哪一步", talkRows(TALKS).map((n) => n.resolved), [null, null, null, false]);
eq("评论的正文按 markdown 认过", talkRows(TALKS)[0].body, [{ kind: "p", text: "第一句" }]);
eq("没有讨论就没有行", [talkRows(null), talkRows([{ notes: [] }])], [[], []]);

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
// The last line of MD is a pipe line with no alignment row under it: a broken table, kept as text.
eq("说明按行认得出结构", mdLines(MD).map((l) => l.kind), ["head", "gap", "check", "check", "li", "li", "quote", "p", "gap", "code", "p"]);
eq("勾选项分得清做完没做", mdLines(MD).filter((l) => l.kind === "check").map((l) => l.done), [true, false]);
eq("行内标记只留文字", mdLines(MD).find((l) => l.kind === "p").text, "带 代码 和 链接 http://a.b 的句子");
eq("缩进过的子项记着层数", mdLines(MD).filter((l) => l.kind === "li").map((l) => [l.depth, l.text]), [[1, "- 缩进的子项"], [0, "1. 第一条"]]);

// The description is the part most likely to be read, so what it loses matters: the table's
// alignment row is not a paragraph, and an identifier inside backticks is not emphasis.
eq("标题带着层数", mdLines("# 一\n## 二").map((l) => [l.kind, l.level]), [["head", 1], ["head", 2]]);
eq("表格整块认出来，分隔行和横线都不算正文", mdLines("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---").map((l) => l.kind), ["table", "gap", "rule"]);
eq("表格按格子切开，转义的竖线留在文字里", mdLines("| a | b |\n| --- | --- |\n| 1 | x\\|y |")[0], { kind: "table", head: ["a", "b"], rows: [["1", "x|y"]] });
eq("续行归到它上面那一项", mdLines("- 一条理由\n  接着一句").map((l) => [l.kind, l.text]), [["li", "- 一条理由\n接着一句"]]);
eq("代码里的下划线不会被当成斜体", mdInline("集中到 `user_session_id` 与 `MAX_RETRY_COUNT`"), "集中到 user_session_id 与 MAX_RETRY_COUNT");
eq("真的强调还是只留文字", mdInline("**校验** 插件提交的 _账号_ 口令"), "校验 插件提交的 账号 口令");

// --- 打开一个评审：问什么、先摆什么 ---
reset();
globalThis.__only();
globalThis.__props = { iid: "3", path: PROJECT, on: "wsl" };
const r = new MrReview();
r.init({}, cx);
await settle();
eq("问的是 space 那台机器上的 glab", globalThis.__calls.map((c) => c.opts.on), ["wsl", "wsl", "wsl", "wsl"]);
eq("开一次问四样：MR、文件、流水线、讨论", globalThis.__calls.map((c) => c.args.at(-1)), [
  `projects/${enc(PROJECT)}/merge_requests/3`,
  `projects/${enc(PROJECT)}/merge_requests/3/diffs?per_page=100`,
  `projects/${enc(PROJECT)}/merge_requests/3/pipelines?per_page=5`,
  `projects/${enc(PROJECT)}/merge_requests/3/discussions?per_page=100`,
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

// 这台 GitLab 用 need_rebase 说"合并被阻止：快进合并不成立"。以前这张表里没有它，状态那格
// 是空白、合并按钮还亮着 —— 看着像能合，点了才被 glab 拒。
diffState.meta = meta({ detailed_merge_status: "need_rebase" });
r.load(cx); await settle();
eq("要 rebase 的时候说得出来", [r.verdict().status, r.verdict().canMerge], ["需先 rebase", false]);
const blocked = r.render();
eq("合并按钮还在，但不给点", [textOf(byId(blocked, "merge-mr")), byId(blocked, "merge-mr")._a.tooltip.includes("需先 rebase")], ["合并", true]);
diffState.meta = meta({ detailed_merge_status: "commits_status" });
r.load(cx); await settle();
eq("提交不齐也不给合", [r.verdict().status, r.verdict().canMerge], ["提交不齐", false]);
diffState.meta = meta({ detailed_merge_status: "something_new" });
r.load(cx); await settle();
eq("没见过的判断照样说出来，也留给 glab 去拒绝", [r.verdict().status, r.verdict().canMerge], ["something_new", true]);
diffState.meta = meta({ detailed_merge_status: "draft_status", draft: true });
r.load(cx); await settle();
eq("草稿是悄悄说的不，也不给合", [r.verdict().status, r.verdict().canMerge], ["草稿", false]);
diffState.meta = meta();
r.load(cx); await settle();
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

// 刷新是问 GitLab"现在"是什么样，整份补丁也在其中：缓存跨过一次次刷新的话，折起来的那个
// 文件会一直显示打开 tab 那天的差异。
reset();
globalThis.__only();
diffState.files = [oneDiff({ collapsed: true, diff: "" })];
const fresh = new MrReview();
fresh.init({}, cx);
await settle();
reset();
fresh.load(cx);
await settle();
eq("刷新会重新问一次整份补丁", globalThis.__calls.map((c) => c.args).filter((a) => a[1] === "diff").length, 1);

// 一次还没问完又点了一次刷新：记下这一次，落定后再问，而不是让点击石沉大海
const before = globalThis.__calls.length;
fresh.loading = true;
fresh.load(cx);
eq("正在问的时候再点，记下来，但不再发一次", [fresh.again, globalThis.__calls.length], [true, before]);
fresh.loading = false;
fresh.again = false;
fresh.busy = true;
fresh.load(cx);
eq("正在合并的时候不排队", fresh.again, false);
fresh.busy = false;
diffState.files = [oneDiff()];

// --- 流水线和讨论：head 上多一个格子，右边多一列 ---
reset();
globalThis.__only();
diffState.pipes = [PIPE({ status: "failed" })];
diffState.talk = TALKS;
const ci = new MrReview();
ci.init({}, cx);
await settle();
eq("流水线失败就写在 GitLab 的判断旁边", textOf(byId(ci.render(), "mr-ci")), "流水线失败");
byId(ci.render(), "mr-ci")._h.on_click({}, cx);
eq("点它开的是那条流水线的页面", globalThis.__opened, [PIPE().web_url]);
eq("按钮上的数只数人说的", [ci.talk.filter((n) => !n.system).length, textOf(byId(ci.render(), "show-talk"))], [3, "讨论 3"]);
eq("没展开就还没有讨论这一列", byId(ci.render(), "mr-talk-3"), null);
// 说明是整窗读的，点了讨论就得从说明里出来，不然那一列开在看不见的地方
ci.setView("desc", true);
byId(ci.render(), "show-talk")._h.on_click({}, cx);
eq("开讨论就把说明收起", ci.view("desc"), false);
const pane = ci.render();
eq("展开后讨论成了一列", Boolean(byId(pane, "mr-talk-3")), true);
eq("评论和系统事件都在列里", [Boolean(byId(pane, "talk-n1")), Boolean(byId(pane, "talk-n3"))], [true, true]);
eq("评论的正文画出来了", textOf(byId(pane, "talk-n1")).includes("第一句"), true);
eq("列头说的是人说的那几条", textOf(byId(pane, "mr-talk-3")).includes("讨论 3 条"), true);
byId(pane, "talk-close")._h.on_click({}, cx);
eq("收起来就只剩文件和差异", byId(ci.render(), "mr-talk-3"), null);
diffState.pipes = [];
diffState.talk = [];

// 这两样是附带的：GitLab 上问不出来，也不能把差异一起带走
reset();
globalThis.__only();
diffState.extraFail = true;
const soft = new MrReview();
soft.init({}, cx);
await settle();
eq("附带的两样问不出来，差异照样在", [soft.error, soft.files.length, soft.ci, soft.talk.length], ["", 1, null, 0]);

// 再问一次没答上来，就留着上一次的：显示的是旧消息，也好过一片空白
diffState.extraFail = false;
diffState.pipes = [PIPE({ status: "failed" })];
diffState.talk = TALKS;
const stale = new MrReview();
stale.init({}, cx);
await settle();
diffState.extraFail = true;
stale.load(cx);
await settle();
eq("答不上来的那一次不清掉上一次的流水线和讨论", [stale.ci?.status, stale.talk.length], ["failed", 4]);
diffState.extraFail = false;
diffState.pipes = [];
diffState.talk = [];

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
// merge -y 碰上还在跑的流水线只是设成"通过后自动合并"，MR 还是开着的，行不能删
eq("还没真的合上就不动列表", globalThis.__shared["mr-review.done"], undefined);

// 真的合上了：列表立刻知道，不用等它下一次轮询
diffState.meta = meta({ state: "merged" });
p.ask("merge");
globalThis.__send("confirm");
await settle();
eq("真合上了就立刻告诉列表", Object.keys(globalThis.__shared["mr-review.done"] ?? {}), [`${PROJECT}!3`]);
diffState.meta = meta();

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
eq("关闭也立刻告诉列表", Object.keys(globalThis.__shared["mr-review.done"] ?? {}), [`${PROJECT}!3`]);

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
eq("合并没做成就什么都不写", globalThis.__shared["mr-review.done"], undefined);

// 关不掉的时候也是一样：行得留在列表上
diffState.fail = true;
reset();
globalThis.__only();
const g2 = new MrReview();
g2.init({}, cx);
await settle();
g2.ask("close");
globalThis.__send("mr-review.confirm");
await settle();
eq("关闭失败也把行留着", globalThis.__shared["mr-review.done"], undefined);
diffState.fail = false;
eq("失败后不 busy，也刷新过了", [g.busy, g.meta.title], [false, "编辑install_c3i_nacos.sql"]);
diffState.fail = false;

// 写出去的是一张会自己缩小的表：新的进去，太旧的出来，不然它只会越来越长
globalThis.__shared["mr-review.done"] = { "old/one!1": Date.now() - 20 * 60e3, "old/two!2": Date.now() - 60e3 };
const kept = markDone("acme/x", 7);
eq("新的一条进去，太旧的出来", Object.keys(kept), ["acme/x!7", "old/two!2"]);

// --- 视图选择放在 shared 里：第二个 review tab 打开就是同一个样子 ---
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
