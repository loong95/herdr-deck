// The agents board: what every coding agent in the window is doing, and which of them is
// waiting for you. A block of the deck's `screens` stack, in place of the tab's panes.
//
// Two views over Herdr's own data (agents(), spaces()) — no bridge, no session log:
//   needs     the agents that are blocked, on the left; the one picked on the right
//   overview  every tab of every space as a card, by status or by workspace
// The rail learns how many are waiting from shared("deck.board.badge"), the way it learns
// the MR count from gitlab-mr; this mod needs to know nothing about the rail.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, nextCommand, spaces, run, shared, setShared, theme } from "herdr";

export const KEY_VIEW = "deck.board.view";        // "needs" | "overview", shared with the rail
export const KEY_PICK = "deck.board.pick";         // the agent the needs view is on
export const KEY_GROUP = "deck.board.group";       // "status" | "space"
export const KEY_BADGE = "deck.board.badge";       // { n, err, ready } — what the rail's icon says
const SCREENS = "screens";                         // the stack this board is a child of
const PANES = "main";                              // …and the child that puts the tab back

// A tab's label: the name someone gave it, else its number ("3").
export function tabLabel(tab) {
  return tab.named && tab.name ? tab.name : tab.name || "tab";
}

// Who an agent is, for people: its tab's name when that says something, else the program.
export function agentName(agent) {
  if (!agent) return "";
  const named = agent.tab_name && !/^\d+$/.test(agent.tab_name) && !/^tb\d+$/.test(agent.tab_name);
  return named ? agent.tab_name : agent.program?.name || agent.app || "Agent";
}

// "now", "13m", "5h", "2d"; "" when unknown.
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const mins = Math.floor((now - ms) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m";
  const hours = Math.floor(mins / 60);
  return hours < 24 ? hours + "h" : Math.floor(hours / 24) + "d";
}

const STATUS_GROUPS = [
  ["Needs you", (status) => status === "blocked"],
  ["Working", (status) => status === "working"],
  ["Done", (status) => status === "done"],
  ["Resting", (status) => status !== "blocked" && status !== "working" && status !== "done"],
];

// Every tab that is not put away, with the space it is in.
export function allTabs(spacesList = spaces()) {
  return (spacesList || []).flatMap((space) =>
    (space.tabs || []).filter((tab) => !tab.settled).map((tab) => ({ space, tab })));
}

// The sections to show, empty ones left out.
export function groups(items, by) {
  if (by === "space") {
    const out = new Map();
    for (const item of items) {
      if (!out.has(item.space.id)) out.set(item.space.id, { title: item.space.name, items: [] });
      out.get(item.space.id).items.push(item);
    }
    return [...out.values()];
  }
  return STATUS_GROUPS.map(([title, test]) => ({ title, items: items.filter((item) => test(item.tab.status)) }))
    .filter((group) => group.items.length);
}

// The agents that wait for the owner, in every space, in Herdr's order.
export function needing(agentsList = agents()) {
  return (agentsList || []).filter((agent) => agent.status === "blocked");
}

// The status mark at the start of a card: a dot when it waits, a ring otherwise (Herdr's own
// spinners are drawn by its agents list; a card is a still picture of what is true now).
export function statusMark(status, t) {
  if (status === "blocked") return div().size(9).m(2).flex_none().rounded(5).bg(t.blocked);
  if (status === "working") return div().size(9).m(2).flex_none().rounded(5).bg(t.working);
  if (status === "done") return div().size(9).m(2).flex_none().rounded(5).bg(t.done);
  return div().size(9).m(2).flex_none().rounded(5).border_1().border_color(t.dim);
}

const view = () => (shared(KEY_VIEW) === "overview" ? "overview" : "needs");

export default class Board extends View {
  constructor() {
    super();
    this.width = 960;
    this.shown = null;
  }

  init(_props, cx) {
    cx.timer.every(1000, (cx) => this.tick(cx));
    // "herdr-app do board.overview" (or a key bound to it), and board.needs back.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "needs" || command === "overview") { setShared(KEY_VIEW, command); cx.notify(); }
      }
    });
    this.publish();
  }

  // Herdr's lists are live snapshots: redraw only when something in them changed.
  signature() {
    const list = needing();
    const tabs = allTabs();
    return [list.map((a) => a.address + ":" + a.seq).join(","), tabs.map((x) => x.tab.id + ":" + x.tab.status + ":" + x.tab.changed_at).join(",")].join("|");
  }

  tick(cx) {
    const sig = this.signature();
    if (sig !== this.shown) { this.shown = sig; this.publish(); cx.notify(); }
  }

  // What the rail's icon says: how many agents wait. Shared, so a copy that is on screen is the
  // one that says it (a hidden copy keeps its timer, so it stays true either way).
  publish() {
    const n = needing().length;
    const was = shared(KEY_BADGE);
    if (!was || was.n !== n || was.err !== false) setShared(KEY_BADGE, { n, err: false, ready: true });
  }

  // …/the board/…: the tab's panes come back, with the screen this button opened left alone.
  showPanes() { run("layout.select", { stack: SCREENS, child: PANES }); }

  // An agent, in its own place: focus its terminal, then put the tab back in front.
  open(agent) {
    if (!agent) return;
    run("space.select", { id: agent.space });
    run("tab.select", { id: agent.tab });
    run("agent.focus", { terminal: agent.address });
    this.showPanes();
  }

  render(cx) {
    const t = theme();
    return v_flex().id("agents-board").size_full().bg(t.background)
      .on_size_change((size, cx) => { if (Math.abs((size?.width ?? 0) - this.width) >= 1) { this.width = size.width; cx.notify(); } })
      .child(this.header(t))
      .child(v_flex().id("agents-body").flex_1().min_h(0).w_full()
        .child(view() === "overview" ? this.overview(t) : this.needs(t, cx)));
  }

  header(t) {
    const waiting = needing().length;
    const tabs = allTabs();
    const working = tabs.filter((x) => x.tab.status === "working").length;
    const tab = (key, label) => div().id("agents-tab-" + key).h(26).px(12).flex().items_center().rounded(7).text_size(12)
      .text_color(view() === key ? t.foreground : t.muted)
      .when(view() === key, (el) => el.bg(t.selected))
      .when(view() !== key, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { setShared(KEY_VIEW, key); cx.notify(); })
      .child(label);
    return h_flex().w_full().h(46).px(14).gap(12).items_center().border_b_1().border_color(t.border)
      .child(h_flex().gap(2).p(2).rounded(9).bg(t.chrome).border_1().border_color(t.border)
        .child(tab("needs", "Needs you" + (waiting ? " · " + waiting : "")))
        .child(tab("overview", "Overview")))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
        .child(tabs.length + (tabs.length === 1 ? " tab" : " tabs") + " · " + working + " working · " + waiting + " need you"))
      .child(div().id("agents-close").px(8).py(3).rounded(6).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => this.showPanes()).child("Esc"));
  }

  // --- needs ---------------------------------------------------------------

  needs(t, cx) {
    const list = needing();
    if (!list.length) {
      return v_flex().id("agents-clear").size_full().items_center().justify_center().gap(8).text_color(t.muted)
        .child(div().size(12).rounded(6).bg(t.done))
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child("All clear"))
        .child(div().text_size(12.5).child("No agent waits for you."));
    }
    const picked = list.find((agent) => agent.address === shared(KEY_PICK)) || list[0];
    const item = (agent) => {
      const on = agent.address === picked.address;
      return h_flex().id("need-" + agent.address).h(48).px(10).gap(9).items_center().rounded(8).flex_none()
        .bg(on ? t.selected : t.background).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => { setShared(KEY_PICK, agent.address); cx.notify(); })
        .child(div().size(8).flex_none().rounded(4).bg(t.blocked))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(agentName(agent)))
          .child(div().truncate().text_size(10.5).text_color(t.muted).child((agent.space_name || "space") + " · waits for you")));
    };
    return h_flex().id("needs-root").size_full().min_h(0).items_start()
      .child(v_flex().id("needs-list").w(320).flex_none().h_full().p(8).gap(2).border_r_1().border_color(t.border)
        .overflow_y_scrollbar()
        .child(div().px(4).pb(6).text_size(13).font_semibold().text_color(t.foreground).child("Needs you · " + list.length))
        .children(list.map(item)))
      .child(v_flex().id("needs-detail").flex_1().min_w(0).h_full().p(20).gap(10)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(agentName(picked)))
        .child(div().text_size(11.5).text_color(t.muted).child(picked.title || picked.space_name || ""))
        .child(v_flex().gap(4).p(12).rounded(8).bg(t.raised).border_1().border_color(t.border)
          .child(div().text_size(12).text_color(t.muted)
            .child("It waits for you in its terminal" + (picked.app ? " (" + picked.app + ")" : "") + "."))
          .child(div().text_size(11).text_color(t.dim).child("Answer it there: the deck does not read the dialog.")))
        .child(h_flex().gap(8)
          .child(div().id("needs-open").px(14).h(30).flex().items_center().rounded(8).text_size(12)
            .bg(t.accent).text_color(t.background).hover((s) => s.opacity(0.9))
            .on_click(() => this.open(picked)).child("Go to its terminal"))));
  }

  // --- overview ------------------------------------------------------------

  overview(t) {
    const items = allTabs();
    const by = shared(KEY_GROUP) === "space" ? "space" : "status";
    const inner = Math.min(1240, Math.max(360, this.width - 56));
    const GAP = 10;
    const CARD = 300;
    const cols = Math.max(1, Math.min(3, Math.floor((inner + GAP) / (CARD + GAP))));
    const width = Math.floor((inner - GAP * (cols - 1)) / cols);
    if (!items.length) {
      return v_flex().size_full().items_center().justify_center().text_size(12.5).text_color(t.muted).child("No tabs yet.");
    }
    const section = (group) => v_flex().gap(8)
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(group.title))
      .child(h_flex().flex_wrap().gap(GAP).children(group.items.map((item) => this.card(item, t, width))));
    return v_flex().id("overview-scroll").size_full().items_center().overflow_y_scrollbar().p(16).gap(20)
      .child(v_flex().w(inner).gap(20)
        .child(h_flex().items_center().gap(10)
          .child(div().flex_1().text_size(12.5).text_color(t.muted).child("Group by"))
          .child(h_flex().p(2).gap(2).rounded(9).bg(t.chrome).border_1().border_color(t.border)
            .child(div().id("group-status").h(24).px(10).flex().items_center().rounded(6).text_size(11.5)
              .text_color(by === "status" ? t.foreground : t.muted).when(by === "status", (el) => el.bg(t.selected))
              .on_click((_e, cx) => { setShared(KEY_GROUP, "status"); cx.notify(); }).child("Status"))
            .child(div().id("group-space").h(24).px(10).flex().items_center().rounded(6).text_size(11.5)
              .text_color(by === "space" ? t.foreground : t.muted).when(by === "space", (el) => el.bg(t.selected))
              .on_click((_e, cx) => { setShared(KEY_GROUP, "space"); cx.notify(); }).child("Workspace"))))
        .children(groups(items, by).map(section)));
  }

  card(item, t, width) {
    const { space, tab } = item;
    const agent = (agents() || []).find((a) => a.tab === tab.id) || null;
    const when = ago(tab.status === "working" ? tab.working_since ?? tab.changed_at : tab.changed_at);
    const sub = [space.name, agent ? agentName(agent) : null].filter(Boolean)
      .filter((x, i, all) => all.indexOf(x) === i && x !== tabLabel(tab)).join(" · ");
    return h_flex().id("ov-" + tab.id).w(width).h(58).px(12).gap(10).items_center().flex_none().rounded(10)
      .bg(t.raised).border_1().border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click(() => { run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); this.showPanes(); })
      .child(statusMark(tab.status, t))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(tabLabel(tab)))
          .when(Boolean(when), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.muted).child(when))))
        .child(div().truncate().text_size(11).text_color(t.muted).child(sub || tab.name || "")));
  }
}
