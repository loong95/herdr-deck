// The right-edge rail: one cell per panel the window can open. An icon shows that panel
// in the stack column beside the rail; clicking the icon already showing closes the
// column and only the rail stays.
//
// Adding a panel is three things and no redesign: a mod folder, a child in the layout's
// `sidepanel` stack, and a row in ENTRIES. The rail reads who is showing from the layout
// and takes only one thing from a panel: what to report on its icon.
//
// The same row is where an agent panel is announced: a Pi / Codex / Claude GUI does not
// live in a stack (it needs a pane of its own), so its entry would run a command instead
// of selecting a stack child. Today only stack children are listed.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, run, shared, theme } from "herdr";

const ENTRIES = [
  { child: "gitlab-mr", icon: "mods/rail/mr.svg", tip: "Merge requests", badge: "gitlab-mr.badge" },
  { child: "pi-sessions", icon: "mods/rail/sessions.svg", tip: "Pi sessions" },
];

const STACK = "sidepanel"; // the stack column this rail opens and closes
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
  showing(child) {
    const s = find(layout(), this.stack);
    return Boolean(s) && !s.hidden && s.active === child;
  }

  click(cx, e) {
    if (this.showing(e.child)) run("layout.hide", { id: this.stack });
    else {
      run("layout.select", { stack: this.stack, child: e.child });
      run("layout.show", { id: this.stack });
    }
    // A layout change is not one of the things that re-renders a mod, so ask for a look
    // once the commands have landed.
    cx.timer.after(80, (cx) => cx.notify());
  }

  cell(t, e, i) {
    const on = this.showing(e.child);
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
