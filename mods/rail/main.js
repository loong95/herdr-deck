// The right-edge rail: one cell per thing the window can show. Two kinds of row:
//
//   { stack, child }           a block in a column beside the rail (the sidepanel stack).
//                              Clicking the one showing closes the column.
//   { screen, child, view? }   a screen of a stack that holds the tab's panes. Clicking
//                              switches to it; clicking it again puts the panes back.
//                              `view` is the state that screen is asked for.
//
// Adding a panel is three things and no redesign: a mod folder, a child in the layout's
// stack, and a row in ENTRIES. The rail reads who is showing from the layout and takes
// only one thing from a panel: what to report on its icon.
//
// A row can also run a command ({ command: "mod.open:pi-gui" }) instead of selecting
// anything, which is how an agent GUI would be announced: it needs a pane of its own.
//
// A mod's folder name must not be one of Herdr's own (agents, tabs, files, …): the app
// replaces shipped mods at start, so a local "agents" is silently not ours. This folder is
// the one place a panel is announced; test/skeleton.test.mjs refuses a shadowing name.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, run, setShared, shared, theme } from "herdr";

const ENTRIES = [
  { stack: "sidepanel", child: "gitlab-mr", icon: "mods/rail/mr.svg", tip: "Merge requests", badge: "gitlab-mr.badge" },
  { stack: "sidepanel", child: "gitlab-issues", icon: "mods/rail/issues.svg", tip: "Issues", badge: "gitlab-issues.badge" },
  { stack: "sidepanel", child: "pi-sessions", icon: "mods/rail/sessions.svg", tip: "Pi sessions" },
  { screen: "screens", child: "board", view: "needs", icon: "mods/rail/needs.svg", tip: "Needs you", badge: "deck.board.badge" },
  { screen: "screens", child: "board", view: "overview", icon: "mods/rail/overview.svg", tip: "Overview" },
];

const STACK = "sidepanel"; // the stack column this rail opens and closes
const PANES = "main";      // the screen that is the tab's own panes
const CELL = 32;

// Which node in the layout document has this id.
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

export default class Rail extends View {
  init(p, _cx) {
    this.stack = p?.stack ?? STACK;
  }

  // Read from the layout, not remembered: the palette and `herdr-app do` can move this
  // column too, and an icon that still glows after that is a lie about the screen.
  showing(e) {
    // A child id on its own means a row of this rail's own stack.
    if (typeof e === "string") e = { stack: this.stack, child: e };
    const s = find(layout(), e.screen ?? e.stack ?? this.stack);
    if (!s || s.hidden) return false;
    if (!e.screen) return s.active === e.child;
    // A screen row is on while its stack shows that child — and, when it names one, while
    // the screen is in that view (the board shows needs or overview, the rail says which).
    const asked = e.view ? (shared(e.viewKey ?? "deck.board.view") ?? "needs") === e.view : true;
    return s.active === e.child && asked;
  }

  click(cx, e) {
    if (e.command) {
      run(e.command);
    } else if (e.screen) {
      // Ask before telling: setting the view first would make the row look like it is
      // already showing, and the press that switches to it would close it instead.
      const on = this.showing(e);
      if (e.view) setShared(e.viewKey ?? "deck.board.view", e.view);
      run("layout.select", { stack: e.screen, child: on ? PANES : e.child });
    } else if (this.showing(e)) run("layout.hide", { id: e.stack ?? this.stack });
    else {
      run("layout.select", { stack: e.stack ?? this.stack, child: e.child });
      run("layout.show", { id: e.stack ?? this.stack });
    }
    // A layout change is not one of the things that re-renders a mod, so ask for a look
    // once the commands have landed.
    cx.timer.after(80, (cx) => cx.notify());
  }

  cell(t, e, i) {
    const on = this.showing(e);
    // A panel with nothing to report has no badge key: shared(undefined) is not a thing.
    const badge = e.badge ? shared(e.badge) : null;
    const told = Boolean(badge) && !on && (badge.err || badge.n > 0);
    return h_flex().id(`rail-${i}`).flex_none().w(CELL).h(CELL).rounded(7).relative()
      .items_center().justify_center()
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .tooltip(e.tip)
      .on_click((_, cx) => this.click(cx, e))
      .child(svg(e.icon).size(16))
      .when(told, (el) => el.child(
        div().absolute().right(2).top(1).text_size(8.5)
          .text_color(badge.err ? t.blocked : t.dim)
          .child(badge.err ? "!" : String(badge.n))));
  }

  render() {
    const t = theme();
    return v_flex().size_full().items_center().gap(4).pt(8).pb(8).bg(t.chrome)
      .children(ENTRIES.map((e, i) => this.cell(t, e, i)));
  }
}
