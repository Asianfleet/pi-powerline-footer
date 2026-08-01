import test from "node:test";
import assert from "node:assert/strict";
import { TUI, visibleWidth } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, renderFixedEditorCluster } from "../fixed-editor/cluster.ts";
import {
  buildFixedClusterPaint,
  DEFAULT_SCROLL_REPAINT_THROTTLE_MS,
  emergencyTerminalModeReset,
  endSynchronizedOutput,
  beginSynchronizedOutput,
  moveCursor,
  resetScrollRegion,
  setScrollRegion,
  type ScrollAwayNavigationCardOptions,
  TerminalSplitCompositor,
} from "../fixed-editor/terminal-split.ts";

class FakeTerminal {
  columns = 40;
  private rowCount = 12;
  writes: string[] = [];

  get rows(): number {
    return this.rowCount;
  }

  setRows(rows: number): void {
    this.rowCount = rows;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  hideCursor(): void {}

  showCursor(): void {}
}

function navigationCardOptions(onClickBottom: () => boolean = () => false): ScrollAwayNavigationCardOptions {
  return {
    shortcuts: [
      { id: "bottom", shortcutLabel: "ctrl+alt+g" },
      { id: "previousUser", shortcutLabel: "ctrl+shift+u" },
      { id: "nextUser", shortcutLabel: "ctrl+shift+i" },
      { id: "previousAssistant", shortcutLabel: "ctrl+alt+," },
      { id: "nextAssistant", shortcutLabel: "ctrl+alt+." },
    ],
    onClickBottom,
  };
}

/** 移除 ANSI 样式码，让测试按可见列检查 root viewport。 */
function stripAnsiForTest(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 返回指定渲染列的字符，用于检查应用内滚动条 gutter。 */
function scrollbarCell(line: string, col: number): string {
  return Array.from(stripAnsiForTest(line)).at(col) ?? "";
}

/** 返回第一段 thumb 的起始行，用于比较滚动条位置变化。 */
function firstThumbRow(lines: string[], col: number): number {
  return lines.findIndex((line) => scrollbarCell(line, col) === "█");
}

/** 移除行尾应用内滚动条，保留正文和其他 ANSI 样式断言。 */
function withoutScrollbar(lines: string[]): string[] {
  return lines.map((line) => {
    return line.replace(
      /(?:\s|\x1b\[0m)*(?:\x1b\[2m│(?:\x1b\[22m|\x1b\[0m)|\x1b\[34m█(?:\x1b\[39m|\x1b\[0m))(?:\x1b\[0m)?(\s*)$/,
      (_match, trailing: string) => " ".repeat(Math.max(0, trailing.length - 1)),
    );
  });
}

/** 断言清行控制序列前已重置 SGR，避免清屏继承背景色。 */
function assertClearLineResetsSgr(write: string): void {
  const chunks = write.split("\x1b[2K");
  for (const prefix of chunks.slice(0, -1)) {
    assert.ok(prefix.endsWith("\x1b[0m"));
  }
}

/** 建立滚动条鼠标交互测试环境，隐藏重复的 compositor 接线。 */
function createScrollbarMouseHarness(options: {
  columns?: number;
  rows?: number;
  lineCount?: number;
  outputPad?: number;
  mouseScroll?: boolean;
  scrollbar?: boolean;
  onCopySelection?: (text: string, source: "auto" | "explicit") => void;
} = {}): {
  terminal: FakeTerminal;
  compositor: TerminalSplitCompositor;
  input: (data: string) => { consume?: boolean; data?: string } | undefined;
  render: (width?: number) => string[];
  rootRenderWidths: number[];
  clusterRenderWidths: number[];
  visible: () => string[];
} {
  const terminal = new FakeTerminal();
  terminal.columns = options.columns ?? 20;
  terminal.setRows(options.rows ?? 12);
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const rootRenderWidths: number[] = [];
  const clusterRenderWidths: number[] = [];
  const rootLines = Array.from({ length: options.lineCount ?? 30 }, (_, index) => `line-${index} abcdefghijklmnopqrstuvwxyz`);
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render(width?: number) {
      rootRenderWidths.push(width ?? terminal.columns);
      return rootLines;
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    outputPad: options.outputPad,
    mouseScroll: options.mouseScroll,
    scrollbar: options.scrollbar,
    onCopySelection: options.onCopySelection,
    renderCluster: (width) => {
      clusterRenderWidths.push(width);
      return { lines: ["cluster-a", "cluster-b"], cursor: null };
    },
  });

  compositor.install();
  const visible = () => withoutScrollbar(tui.render(terminal.columns)).map((line) => stripAnsiForTest(line).trim());

  return {
    terminal,
    compositor,
    input: (data: string) => inputListener?.(data),
    render: (width?: number) => tui.render(width),
    rootRenderWidths,
    clusterRenderWidths,
    visible,
  };
}

test("fixed cluster keeps the editor visible before optional rows", () => {
  const rendered = renderFixedEditorCluster({
    width: 80,
    terminalRows: 6,
    statusLines: ["status"],
    primaryLines: ["top"],
    placement: "above",
    editorLines: ["edit-a", `edit-b ${CURSOR_MARKER}`, "edit-c"],
    secondaryLines: ["secondary"],
    transcriptLines: ["old-1", "old-2"],
    lastPromptLines: ["last"],
  });

  assert.deepEqual(rendered.lines, ["top", "edit-a", "edit-b ", "edit-c", "secondary"]);
  assert.deepEqual(rendered.cursor, { row: 2, col: 7 });
});

test("fixed cluster places only the primary powerline below the editor", () => {
  const rendered = renderFixedEditorCluster({
    width: 80,
    terminalRows: 8,
    statusLines: ["notification", "working"],
    primaryLines: ["primary"],
    placement: "below",
    editorLines: [`edit ${CURSOR_MARKER}`],
    secondaryLines: ["overflow"],
    transcriptLines: ["transcript"],
    lastPromptLines: ["last"],
  });

  assert.deepEqual(rendered.lines, ["notification", "working", "edit ", "primary", "overflow", "transcript", "last"]);
  assert.deepEqual(rendered.cursor, { row: 2, col: 5 });
});

test("fixed cluster keeps primary and overflow priority when placement is below", () => {
  const rendered = renderFixedEditorCluster({
    width: 80,
    terminalRows: 4,
    statusLines: ["status"],
    primaryLines: ["primary"],
    placement: "below",
    editorLines: [`edit ${CURSOR_MARKER}`],
    secondaryLines: ["overflow"],
    transcriptLines: ["transcript"],
    lastPromptLines: ["last"],
  });

  assert.deepEqual(rendered.lines, ["edit ", "primary", "overflow"]);
  assert.deepEqual(rendered.cursor, { row: 0, col: 5 });
});

test("fixed cluster caps oversized editor around the cursor", () => {
  const rendered = renderFixedEditorCluster({
    width: 80,
    terminalRows: 4,
    statusLines: ["status"],
    placement: "above",
    editorLines: ["edit-a", "edit-b", `edit-c ${CURSOR_MARKER}`, "edit-d", "edit-e"],
    transcriptLines: ["old"],
  });

  assert.deepEqual(rendered.lines, ["edit-a", "edit-b", "edit-c "]);
  assert.deepEqual(rendered.cursor, { row: 2, col: 7 });
});

test("fixed cluster caps selector-style editor replacements around the selected row", () => {
  const rendered = renderFixedEditorCluster({
    width: 80,
    terminalRows: 4,
    placement: "above",
    editorLines: [
      "title",
      "  option-a",
      "  option-b",
      "\x1b[38;5;39m→ \x1b[0m\x1b[38;5;39moption-c\x1b[0m",
      "  option-d",
      "hint",
    ],
  });

  assert.deepEqual(rendered.lines, ["  option-b", "\x1b[38;5;39m→ \x1b[0m\x1b[38;5;39moption-c\x1b[0m", "  option-d"]);
});

test("fixed cluster keeps tail status lines when compact", () => {
  const rendered = renderFixedEditorCluster({
    width: 80,
    terminalRows: 3,
    statusLines: ["above-widget", "powerline-status", "⠏ Shaolin Switchblade Sync..."],
    placement: "above",
    editorLines: ["edit"],
  });

  assert.deepEqual(rendered.lines, ["⠏ Shaolin Switchblade Sync...", "edit"]);
});

test("terminal split can render a hidden status container in the fixed cluster", () => {
  const terminal = new FakeTerminal();
  const status = {
    text: "⠏ Shaolin Switchblade Sync...",
    render() {
      return ["", this.text];
    },
  };
  const editor = {
    render() {
      return ["editor"];
    },
  };
  const tui = {
    terminal,
    render() {
      return ["chat"];
    },
    doRender() {
      this.terminal.write("body");
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    getShowHardwareCursor: () => false,
    renderCluster: (width) => ({
      lines: [
        ...compositor.renderHidden(status, width).filter((line) => visibleWidth(line) > 0),
        ...compositor.renderHidden(editor, width),
      ],
      cursor: null,
    }),
  });

  compositor.hideRenderable(status);
  compositor.hideRenderable(editor);
  compositor.install();

  assert.deepEqual(status.render(), []);
  tui.doRender();
  assert.ok(terminal.writes.at(-1)?.includes("⠏ Shaolin Switchblade Sync..."));

  status.text = "⠙ Shaolin Switchblade Sync...";
  compositor.requestRepaint();
  assert.ok(terminal.writes.at(-1)?.includes("⠙ Shaolin Switchblade Sync..."));

  compositor.dispose();
  assert.deepEqual(status.render(), ["", "⠙ Shaolin Switchblade Sync..."]);
});

test("terminal split applies outputPad as an outer fixed-editor inset", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 12;
  const rootRenderWidths: number[] = [];
  const clusterRenderWidths: number[] = [];
  const tui = {
    terminal,
    render(width: number) {
      rootRenderWidths.push(width);
      return [`root:${width}`];
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    outputPad: 1,
    getShowHardwareCursor: () => true,
    renderCluster: (width) => {
      clusterRenderWidths.push(width);
      return { lines: [`cluster:${width}`], cursor: { row: 0, col: 2 } };
    },
  });

  compositor.install();

  assert.deepEqual(tui.render(12), [" root:9 ", "  ", "  ", "  ", "  ", "  ", "  ", "  ", "  ", "  ", "  "]);
  assert.deepEqual(rootRenderWidths, [9]);
  assert.deepEqual(clusterRenderWidths.at(-1), 10);

  compositor.requestRepaint();
  const repaint = terminal.writes.at(-1) ?? "";
  assert.ok(repaint.includes("\x1b[12;1H\x1b[0m\x1b[2K cluster:10 "));
  assert.ok(repaint.includes("\x1b[12;4H\x1b[?25h"));

  compositor.dispose();
});

test("terminal split escape helpers generate DEC scroll region controls", () => {
  assert.equal(beginSynchronizedOutput(), "\x1b[?2026h");
  assert.equal(endSynchronizedOutput(), "\x1b[?2026l");
  assert.equal(setScrollRegion(1, 18), "\x1b[1;18r");
  assert.equal(resetScrollRegion(), "\x1b[r");
  assert.equal(moveCursor(20, 3), "\x1b[20;3H");
});

test("fixed cluster paint clears bottom rows and positions hardware cursor", () => {
  const paint = buildFixedClusterPaint(
    { lines: ["top", "edit"], cursor: { row: 1, col: 2 } },
    10,
    20,
    true,
  );

  assert.match(paint, /^\x1b\[r/);
  assert.ok(paint.includes("\x1b[9;1H\x1b[0m\x1b[2Ktop"));
  assert.ok(paint.includes("\x1b[10;1H\x1b[0m\x1b[2Kedit"));
  assert.ok(paint.endsWith("\x1b[10;3H\x1b[?25h"));
});

test("terminal split reserves rows, hides root renderables, repaints, and cleans up", () => {
  const terminal = new FakeTerminal();
  const hidden = {
    render(width: number) {
      return [`hidden:${width}`];
    },
  };
  const tui = {
    terminal,
    hardwareCursorRow: 2,
    cursorRow: 2,
    previousViewportTop: 0,
    rendered: 0,
    doRender() {
      this.rendered += 1;
      this.terminal.write("body");
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    getShowHardwareCursor: () => false,
    renderCluster: (width) => ({
      lines: [`cluster:${width}`, ...compositor.renderHidden(hidden, width)],
      cursor: null,
    }),
  });

  compositor.hideRenderable(hidden);
  compositor.install();

  assert.deepEqual(hidden.render(40), []);
  assert.equal(terminal.rows, 10);

  tui.doRender();

  assert.equal(tui.rendered, 1);
  assert.equal(terminal.writes.length, 3);
  assert.ok(terminal.writes[0]?.includes("\x1b[?1049h"));
  assert.ok(terminal.writes[0]?.includes("\x1b[?1007l"));
  assert.ok(terminal.writes[0]?.includes("\x1b[?1002h"));
  assert.ok(terminal.writes[0]?.includes("\x1b[?1006h"));
  assert.ok(terminal.writes[1]?.includes("\x1b[1;10r\x1b[3;1Hbody"));
  assert.ok(terminal.writes[1]?.includes("cluster:40"));
  assert.ok(terminal.writes[1]?.includes("hidden:40"));
  assert.ok(terminal.writes[2]?.includes("cluster:40"));

  compositor.dispose();

  assert.deepEqual(hidden.render(8), ["hidden:8"]);
  assert.equal(terminal.rows, 12);
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[r"));
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[?1006l"));
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[?1002l"));
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[?1000l"));
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[?1007h"));
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[?1049l"));
  assert.ok(!terminal.writes.at(-1)?.includes("\x1b[<u"));
  assert.ok(!terminal.writes.at(-1)?.includes("\x1b[>4;0m"));
});

test("terminal split re-enables Kitty keyboard protocol in alternate screen", () => {
  const terminal = new FakeTerminal();
  Object.defineProperty(terminal, "kittyProtocolActive", { value: true });
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();

  const setup = terminal.writes[0] ?? "";
  assert.ok(setup.includes("\x1b[?1049h"));
  assert.ok(setup.includes("\x1b[>7u"));
  assert.ok(setup.indexOf("\x1b[?1049h") < setup.indexOf("\x1b[>7u"));

  compositor.dispose();

  const cleanup = terminal.writes.at(-1) ?? "";
  assert.ok(cleanup.includes("\x1b[<u"));
  assert.ok(cleanup.indexOf("\x1b[<u") < cleanup.indexOf("\x1b[?1049l"));
  assert.ok(!cleanup.includes("\x1b[<999u"));
});

test("terminal split re-enables modifyOtherKeys in alternate screen", () => {
  const terminal = new FakeTerminal();
  Reflect.set(terminal, "_modifyOtherKeysActive", true);
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();

  const setup = terminal.writes[0] ?? "";
  assert.ok(setup.includes("\x1b[?1049h"));
  assert.ok(setup.includes("\x1b[>4;2m"));
  assert.ok(setup.indexOf("\x1b[?1049h") < setup.indexOf("\x1b[>4;2m"));

  compositor.dispose();

  const cleanup = terminal.writes.at(-1) ?? "";
  assert.ok(cleanup.includes("\x1b[>4;0m"));
  assert.ok(cleanup.indexOf("\x1b[>4;0m") < cleanup.indexOf("\x1b[?1049l"));
  assert.ok(!cleanup.includes("\x1b[<999u"));
});

test("terminal split retries Kitty keyboard protocol when negotiation completes after install", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const terminal = new FakeTerminal();
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();

  const setup = terminal.writes[0] ?? "";
  assert.ok(setup.includes("\x1b[?1049h"));
  assert.ok(!setup.includes("\x1b[>7u"));

  terminal.kittyProtocolActive = true;
  t.mock.timers.tick(10);

  assert.equal(terminal.writes.at(-1), "\x1b[>7u");

  compositor.dispose();

  const cleanup = terminal.writes.at(-1) ?? "";
  assert.ok(cleanup.includes("\x1b[<u"));
  assert.ok(cleanup.indexOf("\x1b[<u") < cleanup.indexOf("\x1b[?1049l"));
});

test("terminal split retries modifyOtherKeys when negotiation completes after install", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const terminal = new FakeTerminal();
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  Reflect.set(terminal, "_modifyOtherKeysActive", true);
  t.mock.timers.tick(10);

  assert.equal(terminal.writes.at(-1), "\x1b[>4;2m");

  compositor.dispose();

  const cleanup = terminal.writes.at(-1) ?? "";
  assert.ok(cleanup.includes("\x1b[>4;0m"));
  assert.ok(cleanup.indexOf("\x1b[>4;0m") < cleanup.indexOf("\x1b[?1049l"));
});

test("terminal split cancels pending keyboard retries on dispose", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const terminal = new FakeTerminal();
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  compositor.dispose();
  const writeCount = terminal.writes.length;

  terminal.kittyProtocolActive = true;
  t.mock.timers.tick(100);

  assert.equal(terminal.writes.length, writeCount);
});

test("terminal split restores main screen mode when Kitty activates after install", () => {
  const terminal = new FakeTerminal();
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  terminal.kittyProtocolActive = true;
  compositor.dispose();

  const cleanup = terminal.writes.at(-1) ?? "";
  assert.ok(cleanup.includes("\x1b[<u"));
  assert.ok(cleanup.includes("\x1b[>7u"));
  assert.ok(cleanup.indexOf("\x1b[<u") < cleanup.indexOf("\x1b[?1049l"));
  assert.ok(cleanup.indexOf("\x1b[?1049l") < cleanup.indexOf("\x1b[>7u"));
});

test("terminal split restores main screen mode when modifyOtherKeys activates after install", () => {
  const terminal = new FakeTerminal();
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  Reflect.set(terminal, "_modifyOtherKeysActive", true);
  compositor.dispose();

  const cleanup = terminal.writes.at(-1) ?? "";
  assert.ok(cleanup.includes("\x1b[>4;0m"));
  assert.ok(cleanup.includes("\x1b[>4;2m"));
  assert.ok(cleanup.indexOf("\x1b[>4;0m") < cleanup.indexOf("\x1b[?1049l"));
  assert.ok(cleanup.indexOf("\x1b[?1049l") < cleanup.indexOf("\x1b[>4;2m"));
});

test("terminal split shutdown cleanup resets extended keyboard modes", () => {
  const terminal = new FakeTerminal();
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  compositor.dispose({ resetExtendedKeyboardModes: true });

  const cleanup = terminal.writes.at(-1) ?? "";
  assert.ok(cleanup.includes("\x1b[<999u"));
  assert.ok(cleanup.includes("\x1b[>4;0m"));
  assert.ok(cleanup.indexOf("\x1b[?1049l") < cleanup.indexOf("\x1b[<999u"));
});

test("terminal row reservation does not recurse when hidden editor render reads terminal rows", () => {
  const terminal = new FakeTerminal();
  const tui = { terminal };
  const hidden = {
    render() {
      return [`rows:${terminal.rows}`];
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: (width) => ({
      lines: compositor.renderHidden(hidden, width),
      cursor: null,
    }),
  });

  compositor.hideRenderable(hidden);
  compositor.install();

  assert.equal(terminal.rows, 11);
  compositor.requestRepaint();
  assert.ok(terminal.writes.at(-1)?.includes("rows:12"));

  compositor.dispose();
});

test("terminal split anchors diff writes to the visible viewport row", () => {
  const terminal = new FakeTerminal();
  const tui = {
    terminal,
    hardwareCursorRow: 100,
    cursorRow: 100,
    previousViewportTop: 95,
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  terminal.write("diff");

  assert.ok(terminal.writes[1]?.includes("\x1b[1;10r\x1b[6;1Hdiff"));

  compositor.dispose();
});

test("terminal split does not repaint the fixed cluster over visible overlays", () => {
  const terminal = new FakeTerminal();
  const tui = {
    terminal,
    overlayStack: [{}],
    rendered: 0,
    doRender() {
      this.rendered += 1;
      this.terminal.write("overlay-frame");
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  tui.doRender();
  compositor.requestRepaint();

  assert.deepEqual(terminal.writes, [
    "\x1b[?2026h\x1b[?1049h\x1b[?1007l\x1b[?1002h\x1b[?1006h\x1b[?2026l",
    "overlay-frame",
  ]);

  compositor.dispose();
});

test("terminal split strips OSC markers from root lines while overlays are visible", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 20;
  const tui = {
    terminal,
    overlayStack: [{}],
    render() {
      return ["\x1b]133;B\x07" + "x".repeat(20) + "\x1b]133;C\x07"];
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  const rendered = tui.render(20);

  assert.equal(rendered.length, 1);
  assert.equal(visibleWidth(rendered[0] ?? ""), 20);
  assert.doesNotMatch(rendered[0] ?? "", /\]133/);

  compositor.dispose();
});

test("terminal split keeps tabbed overlay composition within terminal width", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 250;
  terminal.setRows(40);
  const tui = new TUI(terminal, false);
  const overlay = "\x1b[38;2;119;125;136m[grep]: render.ts-706- \treturn [...lines.slice(0, visibleLines), truncLine(theme.fg(\"dim\", hint), width)];\x1b[39m";

  // Pi's own composition leaves the raw tab in place. Its measured width tracks how the
  // installed pi-tui counts "\t" (0 columns historically, 3 since 0.74), so assert only the
  // tab that the compositor patch below is responsible for removing.
  const before = tui.compositeLineAt("Validation before " + " ".repeat(232), overlay, 20, 210, 250);
  assert.match(before, /\t/);

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  const after = tui.compositeLineAt("Validation before " + " ".repeat(232), overlay, 20, 210, 250);

  assert.ok(visibleWidth(after) <= 250);
  assert.doesNotMatch(after, /\t/);

  compositor.dispose();
});

test("terminal split renders chat through an app-owned scroll viewport", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  let rootLines = Array.from({ length: 15 }, (_, index) => `line-${index}`);
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();

  assert.equal(terminal.rows, 10);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-5", "line-6", "line-7", "line-8", "line-9",
    "line-10", "line-11", "line-12", "line-13", "line-14",
  ]);

  assert.deepEqual(inputListener?.("\x1b[<2;1;1M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1bOA"), undefined);
  assert.deepEqual(inputListener?.("\x1bOB"), undefined);
  assert.deepEqual(inputListener?.("\x1b[A"), undefined);
  assert.deepEqual(renderRequests, []);
  assert.deepEqual(inputListener?.("\x1b[<64;1;1M"), { consume: true });
  assert.deepEqual(renderRequests, [undefined]);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-2", "line-3", "line-4", "line-5", "line-6",
    "line-7", "line-8", "line-9", "line-10", "line-11",
  ]);

  rootLines = [...rootLines, "line-15"];
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-2", "line-3", "line-4", "line-5", "line-6",
    "line-7", "line-8", "line-9", "line-10", "line-11",
  ]);

  assert.deepEqual(inputListener?.("\x1b[<65;1;1M"), { consume: true });
  assert.deepEqual(renderRequests, [undefined, undefined]);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-5", "line-6", "line-7", "line-8", "line-9",
    "line-10", "line-11", "line-12", "line-13", "line-14",
  ]);

  assert.deepEqual(inputListener?.("\x1b[5~"), { consume: true });
  assert.deepEqual(renderRequests, [undefined, undefined, undefined]);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-0", "line-1", "line-2", "line-3", "line-4",
    "line-5", "line-6", "line-7", "line-8", "line-9",
  ]);

  compositor.dispose();
  assert.equal(inputListener, null);
});

test("terminal split renders a scrollbar track and thumb for overflowing root content", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 20;
  terminal.setRows(8);
  const tui = {
    terminal,
    render() {
      return Array.from({ length: 18 }, (_, index) => `line-${index}`);
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  const rendered = tui.render(20);
  const gutter = rendered.map((line) => scrollbarCell(line, 18));

  assert.ok(gutter.includes("│"));
  assert.ok(gutter.includes("█"));
  assert.match(rendered.join("\n"), /\x1b\[0m\x1b\[2m│\x1b\[0m/);
  assert.match(rendered.join("\n"), /\x1b\[0m\x1b\[34m█\x1b\[0m/);

  compositor.dispose();
});

test("terminal split accepts custom scrollbar cell colors", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 20;
  terminal.setRows(8);
  const tui = {
    terminal,
    render() {
      return Array.from({ length: 18 }, (_, index) => `line-${index}`);
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
    renderScrollbarCell: (kind: "track" | "thumb") => kind === "thumb"
      ? "\x1b[38;2;95;215;255m█\x1b[0m"
      : "\x1b[38;2;80;80;80m│\x1b[0m",
  });

  compositor.install();
  const rendered = tui.render(20).join("\n");

  assert.match(rendered, /\x1b\[38;2;80;80;80m│\x1b\[0m/);
  assert.match(rendered, /\x1b\[38;2;95;215;255m█\x1b\[0m/);

  compositor.dispose();
});

test("terminal split keeps root content flush left when the scrollbar is visible", () => {
  const { compositor, render } = createScrollbarMouseHarness({ columns: 20, rows: 8 });
  const rendered = render(20);

  assert.notEqual(scrollbarCell(rendered[0] ?? "", 0), " ");
  assert.ok(rendered.map((line) => scrollbarCell(line, 18)).some((cell) => cell === "│" || cell === "█"));
  assert.ok(withoutScrollbar(rendered)[0]?.startsWith("line-24 abcdefghi"));

  compositor.dispose();
});

test("terminal split separates full-width root content from the scrollbar with a spacer", () => {
  const { compositor, render } = createScrollbarMouseHarness({ columns: 20, rows: 8 });
  const rendered = render(20);

  assert.ok(rendered.slice(0, 6).every((line) => scrollbarCell(line, 17) === " "));
  assert.ok(rendered.map((line) => scrollbarCell(line, 18)).some((cell) => cell === "│" || cell === "█"));
  assert.equal(scrollbarCell(rendered[0] ?? "", 19), " ");
  assert.equal(stripAnsiForTest(withoutScrollbar(rendered)[0] ?? ""), "line-24 abcdefghi");

  compositor.dispose();
});

test("terminal split aligns the scrollbar right edge with the fixed editor", () => {
  const { compositor, render, clusterRenderWidths } = createScrollbarMouseHarness({ columns: 20, rows: 8 });
  const rendered = render(20);

  assert.equal(clusterRenderWidths.at(-1), 20);
  assert.ok(rendered.map((line) => scrollbarCell(line, 18)).some((cell) => cell === "│" || cell === "█"));
  assert.equal(scrollbarCell(rendered[0] ?? "", 19), " ");
  assert.equal(stripAnsiForTest(withoutScrollbar(rendered)[0] ?? ""), "line-24 abcdefghi");

  compositor.dispose();
});

test("terminal split resets root line styles before the scrollbar spacer and cell", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 20;
  terminal.setRows(8);
  const tui = {
    terminal,
    render() {
      return Array.from({ length: 18 }, () => "\x1b[48;5;240mabcdefghijklmnopq");
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  const rendered = tui.render(20);

  assert.ok(rendered[0]?.includes("abcdefghijklmnopq\x1b[0m \x1b[0m\x1b[2m│\x1b[0m\x1b[0m "));

  compositor.dispose();
});

test("terminal split restores full root width and ignores scrollbar gutter clicks when scrollbar is false", () => {
  const { compositor, input, render, rootRenderWidths, visible } = createScrollbarMouseHarness({
    columns: 20,
    rows: 8,
    scrollbar: false,
  });
  const rendered = render(20);
  const gutter = rendered.map((line) => scrollbarCell(line, 19));

  assert.deepEqual(rootRenderWidths, [20]);
  assert.notEqual(scrollbarCell(rendered[0] ?? "", 0), " ");
  assert.ok(!gutter.includes("│"));
  assert.ok(!gutter.includes("█"));
  assert.equal(visible()[0], "line-24 abcdefghijkl");
  assert.deepEqual(input("\x1b[<0;20;1M"), { consume: true });
  assert.equal(visible()[0], "line-24 abcdefghijkl");

  compositor.dispose();
});

test("terminal split places the scrollbar thumb at the bottom when root scrollOffset is zero", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 20;
  terminal.setRows(8);
  const tui = {
    terminal,
    render() {
      return Array.from({ length: 18 }, (_, index) => `line-${index}`);
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  const gutter = tui.render(20).map((line) => scrollbarCell(line, 18));

  assert.equal(gutter.at(-1), "█");
  assert.equal(firstThumbRow(tui.render(20), 18) > 0, true);

  compositor.dispose();
});

test("terminal split moves the scrollbar thumb upward after PageUp", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 20;
  terminal.setRows(8);
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 18 }, (_, index) => `line-${index}`);
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  const bottomThumbRow = firstThumbRow(tui.render(20), 18);

  assert.deepEqual(inputListener?.("\x1b[5~"), { consume: true });
  const pageUpThumbRow = firstThumbRow(tui.render(20), 18);

  assert.ok(pageUpThumbRow >= 0);
  assert.ok(pageUpThumbRow < bottomThumbRow);

  compositor.dispose();
});

test("terminal split leaves the scrollbar gutter empty when root content does not overflow", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 20;
  terminal.setRows(8);
  const tui = {
    terminal,
    render() {
      return ["line-0", "line-1", "line-2"];
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  const gutter = tui.render(20).map((line) => scrollbarCell(line, 19));

  assert.ok(!gutter.includes("│"));
  assert.ok(!gutter.includes("█"));

  compositor.dispose();
});

test("terminal split keeps the root content left edge stable when scrollbar visibility changes", () => {
  const withoutOverflow = createScrollbarMouseHarness({ columns: 20, rows: 8, lineCount: 3 });
  const withOverflow = createScrollbarMouseHarness({ columns: 20, rows: 8, lineCount: 30 });

  const withoutOverflowFirstLine = stripAnsiForTest(withoutOverflow.render(20)[0] ?? "");
  const withOverflowFirstLine = stripAnsiForTest(withOverflow.render(20)[0] ?? "");

  assert.equal(withoutOverflowFirstLine[0], "l");
  assert.equal(withOverflowFirstLine[0], "l");

  withoutOverflow.compositor.dispose();
  withOverflow.compositor.dispose();
});

test("terminal split renders the scrollbar inside the outputPad content area", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 12;
  terminal.setRows(8);
  const tui = {
    terminal,
    render() {
      return Array.from({ length: 18 }, (_, index) => `line-${index}`);
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    outputPad: 1,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  const rendered = tui.render(12);
  const scrollbar = rendered.map((line) => scrollbarCell(line, 9));
  const innerGutter = rendered.map((line) => scrollbarCell(line, 10));
  const outerPadding = rendered.map((line) => scrollbarCell(line, 11));

  assert.ok(scrollbar.includes("│"));
  assert.ok(scrollbar.includes("█"));
  assert.ok(innerGutter.every((cell) => cell === " "));
  assert.ok(outerPadding.every((cell) => cell === " "));

  compositor.dispose();
});

test("terminal split jumps root viewport when left-clicking the scrollbar gutter", () => {
  const { compositor, input, visible } = createScrollbarMouseHarness();

  assert.equal(visible()[0], "line-20 abcdefghi");
  assert.deepEqual(input("\x1b[<0;19;1M"), { consume: true });
  assert.equal(visible()[0], "line-0 abcdefghij");

  compositor.dispose();
});

test("terminal split updates root viewport while dragging the scrollbar gutter", () => {
  const { compositor, input, visible } = createScrollbarMouseHarness();

  assert.deepEqual(input("\x1b[<0;19;1M"), { consume: true });
  assert.equal(visible()[0], "line-0 abcdefghij");
  assert.deepEqual(input("\x1b[<32;19;12M"), { consume: true });
  assert.equal(visible()[0], "line-20 abcdefghi");

  compositor.dispose();
});

test("terminal split ends scrollbar dragging on mouse release", () => {
  const { compositor, input, visible } = createScrollbarMouseHarness();

  assert.deepEqual(input("\x1b[<0;19;1M"), { consume: true });
  assert.equal(visible()[0], "line-0 abcdefghij");
  assert.deepEqual(input("\x1b[<0;19;1m"), { consume: true });
  assert.deepEqual(input("\x1b[<32;19;12M"), { consume: true });
  assert.equal(visible()[0], "line-0 abcdefghij");

  compositor.dispose();
});

test("terminal split scrollbar clicks do not create or copy a text selection", () => {
  const copied: Array<{ text: string; source: string }> = [];
  const { compositor, input } = createScrollbarMouseHarness({
    onCopySelection: (text, source) => copied.push({ text, source }),
  });

  assert.deepEqual(input("\x1b[<0;19;1M"), { consume: true });
  assert.deepEqual(input("\x1b[<32;19;3M"), { consume: true });
  assert.deepEqual(input("\x1b[<0;19;3m"), { consume: true });
  assert.deepEqual(copied, []);
  assert.equal(input("\x03"), undefined);
  assert.deepEqual(copied, []);

  compositor.dispose();
});

test("terminal split does not consume scrollbar SGR mouse packets when mouseScroll is false", () => {
  const { compositor, input, visible } = createScrollbarMouseHarness({ mouseScroll: false });

  assert.equal(visible()[0], "line-20 abcdefghi");
  assert.equal(input("\x1b[<0;20;1M"), undefined);
  assert.equal(visible()[0], "line-20 abcdefghi");

  compositor.dispose();
});

test("terminal split maps outputPad scrollbar clicks to the padded inner gutter column", () => {
  const { compositor, input, visible } = createScrollbarMouseHarness({ columns: 12, outputPad: 1 });

  assert.equal(visible()[0], "line-20");
  assert.deepEqual(input("\x1b[<0;12;1M"), { consume: true });
  assert.equal(visible()[0], "line-20");
  assert.deepEqual(input("\x1b[<0;10;1M"), { consume: true });
  assert.equal(visible()[0], "line-0");

  compositor.dispose();
});

test("terminal split repaints the full viewport while the scrollbar is visible", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 40;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  let rootRenderCalls = 0;
  const rootLines = Array.from({ length: 30 }, (_, index) => `line-${index}`);
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => { inputListener = null; };
    },
    requestRender() {},
    render() {
      rootRenderCalls += 1;
      return rootLines;
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);
  terminal.writes = [];

  assert.deepEqual(inputListener?.("\x1b[<64;1;1M"), { consume: true });
  assert.equal(rootRenderCalls, 2);
  assert.equal(terminal.writes.length, 1);
  assert.doesNotMatch(terminal.writes[0] ?? "", /\x1b\[3T/);
  assert.equal((terminal.writes[0]?.match(/\x1b\[2K/g) ?? []).length, 12);
  assertClearLineResetsSgr(terminal.writes[0] ?? "");
  assert.deepEqual(withoutScrollbar(tui.render(40)).slice(0, 3), ["line-17", "line-18", "line-19"]);

  terminal.writes = [];
  assert.deepEqual(inputListener?.("\x1b[<65;1;1M"), { consume: true });
  assert.equal(terminal.writes.length, 1);
  assert.doesNotMatch(terminal.writes[0] ?? "", /\x1b\[3S/);
  assert.equal((terminal.writes[0]?.match(/\x1b\[2K/g) ?? []).length, 12);
  assertClearLineResetsSgr(terminal.writes[0] ?? "");
  assert.deepEqual(withoutScrollbar(tui.render(40)).slice(0, 3), ["line-20", "line-21", "line-22"]);

  compositor.dispose();
});

test("terminal split refreshes root lines when Pi has a render pending", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  let rootLines = Array.from({ length: 30 }, (_, index) => `old-${index}`);
  const tui = {
    terminal,
    renderRequested: false,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => { inputListener = null; };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);
  rootLines = Array.from({ length: 31 }, (_, index) => `new-${index}`);
  tui.renderRequested = true;

  inputListener?.("\x1b[<64;1;1M");
  assert.ok(withoutScrollbar(tui.render(40)).every((line) => line.startsWith("new-")));

  compositor.dispose();
});

test("terminal split repaints the navigation card during full scrollbar viewport paints", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 80;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const rootLines = Array.from({ length: 40 }, (_, index) => `line-${index}`);
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => { inputListener = null; };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollAwayNavigationCard: navigationCardOptions(),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(80);
  inputListener?.("\x1b[<64;1;1M");
  terminal.writes = [];
  inputListener?.("\x1b[<64;1;1M");

  const paint = terminal.writes[0] ?? "";
  const shiftIndex = paint.indexOf("\x1b[3T");
  assert.equal(shiftIndex, -1);
  assert.ok(paint.includes("line-"));
  assert.ok(paint.includes("Jump to bottom"));
  assert.ok(tui.render(80).some((line) => line.includes("Jump to bottom")));

  compositor.dispose();
});

test("terminal split defers the navigation card while wheel scrolling is active", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const terminal = new FakeTerminal();
  terminal.columns = 80;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  const rootLines = Array.from({ length: 40 }, (_, index) => `line-${index}`);
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => { inputListener = null; };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return rootLines;
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollRepaintThrottleMs: DEFAULT_SCROLL_REPAINT_THROTTLE_MS,
    scrollAwayNavigationCard: navigationCardOptions(),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(80);
  terminal.writes = [];
  inputListener?.("\x1b[<64;1;1M");

  t.mock.timers.tick(7);
  assert.equal(terminal.writes.length, 0);
  t.mock.timers.tick(1);
  assert.equal(terminal.writes.length, 1);
  assert.doesNotMatch(terminal.writes[0] ?? "", /Jump to bottom/);
  assert.equal((terminal.writes[0]?.match(/\x1b\[2K/g) ?? []).length, 12);
  assert.ok(!tui.render(80).some((line) => line.includes("Jump to bottom")));

  t.mock.timers.tick(80);
  assert.deepEqual(renderRequests, [undefined]);
  assert.ok(tui.render(80).some((line) => line.includes("Jump to bottom")));

  terminal.writes = [];
  inputListener?.("\x1b[<64;1;1M");
  t.mock.timers.tick(8);
  const paint = terminal.writes[0] ?? "";
  assert.doesNotMatch(paint, /\x1b\[3T/);
  assert.ok(paint.includes("line-"));
  assert.doesNotMatch(paint, /Jump to bottom/);

  compositor.dispose();
});

test("terminal split coalesces throttled wheel bursts", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const terminal = new FakeTerminal();
  terminal.columns = 40;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  const rootLines = Array.from({ length: 15 }, (_, index) => `line-${index}`);
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollRepaintThrottleMs: 16,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);
  terminal.writes = [];

  assert.deepEqual(inputListener?.("\x1b[<65;1;1M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<64;1;1M"), { consume: true });
  assert.equal(terminal.writes.length, 0);
  assert.deepEqual(renderRequests, []);

  t.mock.timers.tick(16);
  assert.equal(terminal.writes.length, 1);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-2", "line-3", "line-4", "line-5", "line-6",
    "line-7", "line-8", "line-9", "line-10", "line-11",
  ]);
  assert.deepEqual(renderRequests, []);

  t.mock.timers.tick(80);
  assert.deepEqual(renderRequests, [undefined]);

  compositor.dispose();
});

test("terminal split cancels queued wheel scroll when jumping to bottom", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const terminal = new FakeTerminal();
  terminal.columns = 40;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  const rootLines = Array.from({ length: 15 }, (_, index) => `line-${index}`);
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollRepaintThrottleMs: 16,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);
  assert.deepEqual(inputListener?.("\x1b[5~"), { consume: true });
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-0", "line-1", "line-2", "line-3", "line-4",
    "line-5", "line-6", "line-7", "line-8", "line-9",
  ]);

  terminal.writes = [];
  renderRequests.length = 0;
  assert.deepEqual(inputListener?.("\x1b[<64;1;1M"), { consume: true });
  assert.equal(compositor.jumpToRootBottom(), true);

  t.mock.timers.tick(16);
  assert.equal(terminal.writes.length, 0);
  assert.deepEqual(renderRequests, [undefined]);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-5", "line-6", "line-7", "line-8", "line-9",
    "line-10", "line-11", "line-12", "line-13", "line-14",
  ]);

  compositor.dispose();
});

test("terminal split ignores card clicks created only by a queued wheel flush", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const terminal = new FakeTerminal();
  terminal.columns = 80;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  let bottomClicks = 0;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollRepaintThrottleMs: 16,
    scrollAwayNavigationCard: navigationCardOptions(() => {
      bottomClicks++;
      return true;
    }),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  assert.ok(!tui.render(80).some((line) => line.includes("Jump to bottom")));

  assert.deepEqual(inputListener?.("\x1b[<64;20;6M"), { consume: true });
  assert.ok(!tui.render(80).some((line) => line.includes("Jump to bottom")));
  assert.deepEqual(inputListener?.("\x1b[<0;20;6M"), { consume: true });

  assert.equal(bottomClicks, 0);
  assert.ok(tui.render(80).some((line) => line.includes("Jump to bottom")));

  compositor.dispose();
});

test("terminal split routes scroll-away card clicks after the outputPad outer gutter", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 13;
  terminal.setRows(6);
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  let bottomClicks = 0;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 8 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    outputPad: 1,
    scrollAwayNavigationCard: navigationCardOptions(() => {
      bottomClicks++;
      return true;
    }),
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  tui.render(13);
  inputListener?.("\x1b[5~");
  const rendered = tui.render(13);
  const cardRow = rendered.findIndex((line) => line.includes("Bottom")) + 1;
  assert.ok(cardRow > 0, "compact card should render");

  assert.deepEqual(inputListener?.(`\x1b[<0;1;${cardRow}M`), { consume: true });
  assert.equal(bottomClicks, 0);
  assert.deepEqual(inputListener?.(`\x1b[<0;2;${cardRow}M`), { consume: true });
  assert.equal(bottomClicks, 1);
  assert.deepEqual(inputListener?.(`\x1b[<0;3;${cardRow}M`), { consume: true });
  assert.equal(bottomClicks, 2);

  compositor.dispose();
});

test("terminal split renders a scroll-away navigation card in render and repaint paths", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 80;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  let rootLines = Array.from({ length: 30 }, (_, index) => `line-${index}`);
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return rootLines;
    },
  };

  let compositor: TerminalSplitCompositor;
  compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollAwayNavigationCard: navigationCardOptions(() => compositor.jumpToRootBottom()),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();

  assert.ok(!tui.render(80).some((line) => line.includes("Jump to bottom")));
  terminal.writes = [];

  assert.deepEqual(inputListener?.("\x1b[5~"), { consume: true });
  assert.deepEqual(renderRequests, [undefined]);
  assert.match(terminal.writes.at(-1) ?? "", /Jump to bottom/);
  assert.match(terminal.writes.at(-1) ?? "", /ctrl\+alt\+g/);

  const away = tui.render(80);
  assert.ok(away.some((line) => line.includes("Jump to bottom")));
  assert.ok(away.some((line) => line.includes("User messages")));
  assert.ok(away.some((line) => line.includes("Assistant responses")));

  const firstVisibleLine = away[0];
  rootLines = [...rootLines, "line-30"];
  const anchored = tui.render(80);
  assert.equal(anchored[0], firstVisibleLine);
  assert.ok(anchored.some((line) => line.includes("Jump to bottom")));

  const bottomRowIndex = anchored.findIndex((line) => line.includes("Jump to bottom"));
  const bottomCol = (anchored[bottomRowIndex] ?? "").indexOf("│") + 2;
  assert.deepEqual(inputListener?.(`\x1b[<0;${bottomCol};${bottomRowIndex + 1}M`), { consume: true });
  assert.ok(!tui.render(80).some((line) => line.includes("Jump to bottom")));

  compositor.dispose();
});

test("terminal split routes every scroll-away shortcut card click to bottom", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 80;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const bottomClicks: string[] = [];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollAwayNavigationCard: navigationCardOptions(() => {
      bottomClicks.push("bottom");
      return true;
    }),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(80);
  inputListener?.("\x1b[5~");
  const rendered = tui.render(80);

  const topRowIndex = rendered.findIndex((line) => line.includes("┌") && line.includes("┐"));
  const dividerRowIndex = rendered.findIndex((line) => line.includes("├") && line.includes("┤"));
  const bottomBorderRowIndex = rendered.findIndex((line) => line.includes("└") && line.includes("┘"));
  assert.notEqual(topRowIndex, -1, "card top border should render");
  assert.notEqual(dividerRowIndex, -1, "card divider should render");
  assert.notEqual(bottomBorderRowIndex, -1, "card bottom border should render");

  const topLine = rendered[topRowIndex] ?? "";
  const start = topLine.indexOf("┌");
  const end = topLine.indexOf("┐");
  assert.ok(start >= 0 && end > start, "card should have horizontal bounds");

  function rowFor(label: string): number {
    const rowIndex = rendered.findIndex((line) => line.includes(label));
    assert.notEqual(rowIndex, -1, `${label} row should render`);
    return rowIndex + 1;
  }

  const firstCol = start + 1;
  const lastCol = end + 1;
  const rightHalfCol = start + Math.floor((end - start + 1) / 2) + 1;
  const clickTargets = [
    { col: firstCol, row: topRowIndex + 1 },
    { col: rightHalfCol, row: rowFor("Jump to bottom") },
    { col: firstCol, row: dividerRowIndex + 1 },
    { col: firstCol, row: rowFor("User messages") },
    { col: rightHalfCol, row: rowFor("User messages") },
    { col: firstCol, row: rowFor("Assistant responses") },
    { col: rightHalfCol, row: rowFor("Assistant responses") },
    { col: lastCol, row: bottomBorderRowIndex + 1 },
  ];

  for (const target of clickTargets) {
    assert.deepEqual(inputListener?.(`\x1b[<0;${target.col};${target.row}M`), { consume: true });
  }
  assert.deepEqual(inputListener?.(`\x1b[<0;${lastCol + 1};${rowFor("Jump to bottom")}M`), { consume: true });

  assert.deepEqual(bottomClicks, clickTargets.map(() => "bottom"));

  compositor.dispose();
});

test("terminal split scroll-away navigation card width tiers collapse without wrapping", () => {
  const cases = [
    { width: 80, includes: ["Jump to bottom", "User messages", "Assistant responses"], excludes: [], clickText: "┌" },
    { width: 50, includes: ["Bottom", "User", "Assistant", "prev ctrl+shift+u"], excludes: ["Jump to bottom"], clickText: "┌" },
    { width: 30, includes: ["User prev/next", "⌃⇧U/I", "Asst prev/next", "⌃⌥,/."], excludes: ["User messages"], clickText: "┌" },
    { width: 20, includes: ["Bottom ↓"], excludes: ["User prev/next", "ctrl+alt+g"], clickText: "Bottom ↓" },
    { width: 9, includes: [], excludes: ["Bottom", "ctrl+alt+g"], clickText: null },
    { width: 8, includes: [], excludes: ["Bottom"], clickText: null },
  ];

  for (const { width, includes, excludes, clickText } of cases) {
    const terminal = new FakeTerminal();
    terminal.columns = width;
    let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
    let bottomClicks = 0;
    const tui = {
      terminal,
      addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
        inputListener = listener;
        return () => {
          inputListener = null;
        };
      },
      requestRender() {},
      render() {
        return Array.from({ length: 30 }, (_, index) => `line-${index}`);
      },
    };

    const compositor = new TerminalSplitCompositor({
      tui,
      terminal,
      scrollAwayNavigationCard: navigationCardOptions(() => {
        bottomClicks++;
        return true;
      }),
      renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
    });

    compositor.install();
    tui.render(width);
    inputListener?.("\x1b[5~");
    const rendered = tui.render(width);
    const output = rendered.join("\n");

    for (const expected of includes) {
      assert.ok(output.includes(expected), `width ${width} should include ${expected}`);
    }
    for (const unexpected of excludes) {
      assert.ok(!output.includes(unexpected), `width ${width} should not include ${unexpected}`);
    }
    for (const line of rendered) {
      assert.ok(visibleWidth(line) <= width, `width ${width} line should not wrap: ${line}`);
    }

    if (clickText) {
      const rowIndex = rendered.findIndex((line) => line.includes(clickText));
      assert.notEqual(rowIndex, -1, `width ${width} should have a clickable card row`);
      const line = rendered[rowIndex] ?? "";
      const start = line.indexOf(clickText);
      const clickWidth = clickText === "┌"
        ? visibleWidth(line.slice(start, line.indexOf("┐") + 1))
        : visibleWidth(clickText);
      assert.deepEqual(inputListener?.(`\x1b[<0;${start + 1};${rowIndex + 1}M`), { consume: true });
      if (start + clickWidth < width) {
        assert.deepEqual(inputListener?.(`\x1b[<0;${start + clickWidth + 1};${rowIndex + 1}M`), { consume: true });
      } else {
        assert.deepEqual(inputListener?.("\x1b[<0;1;1M"), { consume: true });
      }
      assert.equal(bottomClicks, 1, `width ${width} should only click inside the card`);
    } else {
      assert.deepEqual(inputListener?.("\x1b[<0;1;1M"), { consume: true });
      assert.equal(bottomClicks, 0, `width ${width} should not render a clickable card`);
    }

    compositor.dispose();
  }
});

test("terminal split omits disabled scroll-away shortcut labels", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 80;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  let bottomClicks = 0;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollAwayNavigationCard: {
      shortcuts: [
        { id: "previousUser", shortcutLabel: "ctrl+shift+u" },
        { id: "nextAssistant", shortcutLabel: "ctrl+alt+." },
      ],
      onClickBottom: undefined,
    },
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(80);
  inputListener?.("\x1b[5~");
  const rendered = tui.render(80);
  const output = rendered.join("\n");

  assert.ok(output.includes("Previous user"));
  assert.ok(output.includes("Next assistant"));
  assert.ok(!output.includes("Jump to bottom"));
  assert.ok(!output.includes("ctrl+alt+g"));

  const rowIndex = rendered.findIndex((line) => line.includes("Previous user"));
  assert.notEqual(rowIndex, -1);
  assert.deepEqual(inputListener?.(`\x1b[<0;1;${rowIndex + 1}M`), { consume: true });
  assert.equal(bottomClicks, 0);

  compositor.dispose();
});

test("terminal split suppresses the scroll-away navigation card while overlays are visible", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 80;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const overlayStack: unknown[] = [];
  const tui = {
    terminal,
    overlayStack,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    scrollAwayNavigationCard: navigationCardOptions(),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(80);
  inputListener?.("\x1b[5~");
  assert.ok(tui.render(80).some((line) => line.includes("Jump to bottom")));

  overlayStack.push({});
  assert.ok(!tui.render(80).some((line) => line.includes("Jump to bottom")));

  compositor.dispose();
});

test("terminal split refreshes scroll bounds after fixed status rows appear", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  const rootLines = Array.from({ length: 11 }, (_, index) => `line-${index}`);
  let statusVisible = false;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({
      lines: statusVisible ? ["⠏ fixed status", "editor"] : ["editor"],
      cursor: null,
    }),
  });

  compositor.install();

  assert.deepEqual(tui.render(40), rootLines);

  statusVisible = true;

  assert.deepEqual(inputListener?.("\x1b[<64;1;1M"), { consume: true });
  assert.deepEqual(renderRequests, [undefined]);
  assert.match(terminal.writes.at(-1) ?? "", /line-0/);
  assert.match(terminal.writes.at(-1) ?? "", /⠏ fixed status/);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-0", "line-1", "line-2", "line-3", "line-4",
    "line-5", "line-6", "line-7", "line-8", "line-9",
  ]);

  compositor.dispose();
});

test("terminal split clamps a stale offset when fixed rows disappear before repaint", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const rootLines = Array.from({ length: 12 }, (_, index) => `line-${index}`);
  let statusVisible = true;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => { inputListener = null; };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({
      lines: statusVisible ? ["⠏ fixed status", "editor"] : ["editor"],
      cursor: null,
    }),
  });

  compositor.install();
  tui.render(40);
  inputListener?.("\x1b[5~");
  assert.deepEqual(withoutScrollbar(tui.render(40)).slice(0, 2), ["line-0", "line-1"]);

  statusVisible = false;
  terminal.writes = [];
  assert.deepEqual(inputListener?.("\x1b[<64;1;1M"), { consume: true });
  assert.equal(terminal.writes.length, 1);
  assert.deepEqual(withoutScrollbar(tui.render(40)).slice(0, 2), ["line-0", "line-1"]);
  assert.match(terminal.writes[0] ?? "", /editor/);

  compositor.dispose();
});

test("terminal split handles modified SGR wheel packets", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return Array.from({ length: 15 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  assert.deepEqual(inputListener?.("\x1b[<68;1;1M"), { consume: true });
  assert.deepEqual(renderRequests, [undefined]);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-2", "line-3", "line-4", "line-5", "line-6",
    "line-7", "line-8", "line-9", "line-10", "line-11",
  ]);

  assert.deepEqual(inputListener?.("\x1b[<68;1;1M\x1b[<68;1;1M"), { consume: true });
  assert.deepEqual(renderRequests, [undefined, undefined]);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-0", "line-1", "line-2", "line-3", "line-4",
    "line-5", "line-6", "line-7", "line-8", "line-9",
  ]);

  assert.deepEqual(inputListener?.("\x1b[<69;1;1M"), { consume: true });
  assert.deepEqual(renderRequests, [undefined, undefined, undefined]);

  compositor.dispose();
});

test("terminal split guards wrapped terminal writes", () => {
  const terminal = new FakeTerminal();
  const tui = {
    terminal,
    hardwareCursorRow: 2,
    previousViewportTop: 0,
    render() {
      return Array.from({ length: 15 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  terminal.write("\x1b[?1006l\x1b[?1002l" + "x".repeat(40));

  const write = terminal.writes.at(-1) ?? "";
  assert.ok(write.includes("\x1b[?1006l\x1b[?1002l" + "x".repeat(40)));
  assert.ok(write.indexOf("\x1b[?7l") < write.indexOf("x".repeat(40)));
  assert.ok(write.lastIndexOf("\x1b[?7h") > write.lastIndexOf("x".repeat(40)));
  assert.ok(write.lastIndexOf("\x1b[?1002h\x1b[?1006h") > write.lastIndexOf("\x1b[?1006l\x1b[?1002l"));

  compositor.dispose();
});

test("terminal split pauses mouse reporting on right click for the terminal context menu", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  const copied: string[] = [];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return Array.from({ length: 20 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text) => copied.push(text),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  assert.deepEqual(inputListener?.("\x1b[<0;5;5M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;5;5m"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<2;5;5M"), { consume: true });
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[?1006l\x1b[?1002l\x1b[?1000l"));
  assert.deepEqual(inputListener?.("\x1b[<0;5;5M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;5;5m"), { consume: true });
  assert.deepEqual(copied, []);
  assert.deepEqual(renderRequests, [undefined, undefined, undefined, undefined]);

  compositor.dispose();
});

test("terminal split selects visible chat text and copies it on drag release", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  const copied: string[] = [];
  const rootLines = [
    "old-0", "old-1", "old-2", "old-3", "old-4",
    "alpha one", "bravo two", "charlie three", "delta four", "echo five",
    "foxtrot six", "golf seven", "hotel eight", "india nine", "juliet ten",
  ];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text) => copied.push(text),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "alpha one", "bravo two", "charlie three", "delta four", "echo five",
    "foxtrot six", "golf seven", "hotel eight", "india nine", "juliet ten",
  ]);

  assert.deepEqual(inputListener?.("\x1b[<0;1;2M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;6;4M"), { consume: true });
  assert.deepEqual(withoutScrollbar(tui.render(40)).slice(1, 4), [
    "\x1b[7mbravo two\x1b[27m",
    "\x1b[7mcharlie three\x1b[27m",
    "\x1b[7mdelta\x1b[27m four",
  ]);
  assert.deepEqual(inputListener?.("\x1b[<0;6;4m"), { consume: true });

  assert.deepEqual(copied, ["bravo two\ncharlie three\ndelta"]);
  assert.ok(!terminal.writes.at(-1)?.includes("\x1b[?1006l\x1b[?1002l\x1b[?1000l"));
  assert.deepEqual(renderRequests, [undefined, undefined, undefined]);

  compositor.dispose();
});

test("terminal split clamps outputPad gutter selection to content edges", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 10;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: string[] = [];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return ["abcdefgh"];
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    outputPad: 1,
    onCopySelection: (text) => copied.push(text),
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  assert.equal(tui.render(10)[0], " abcdefgh ");

  assert.deepEqual(inputListener?.("\x1b[<0;2;1M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;10;1m"), { consume: true });

  assert.deepEqual(copied, ["abcdefg"]);

  compositor.dispose();
});

test("terminal split refreshes root lines before mouse selection hit-testing", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: string[] = [];
  let rootLines = ["alpha one", "bravo two", "charlie three"];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text) => copied.push(text),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);
  rootLines = Array.from({ length: 15 }, (_, index) => `line-${index}`);

  assert.deepEqual(inputListener?.("\x1b[<0;1;1M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;1;2M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;1;2m"), { consume: true });

  assert.deepEqual(copied, ["line-5"]);

  compositor.dispose();
});

test("terminal split restores app-owned selection after context menu copy", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  let clipboard = "";
  const rootLines = [
    "old-0", "old-1", "old-2", "old-3", "old-4",
    "alpha one", "bravo two", "charlie three", "delta four", "echo five",
    "foxtrot six", "golf seven", "hotel eight", "india nine", "juliet ten",
  ];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render(_width?: number) {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text) => {
      clipboard = text;
    },
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  assert.deepEqual(inputListener?.("\x1b[<0;1;2M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;6;4M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;6;4m"), { consume: true });
  assert.equal(clipboard, "bravo two\ncharlie three\ndelta");

  clipboard = "clicked-word";
  assert.deepEqual(inputListener?.("\x1b[<2;4;3M"), { consume: true });
  assert.equal(clipboard, "bravo two\ncharlie three\ndelta");
  assert.ok(tui.render(40)[1]?.includes("\x1b[7mbravo two\x1b[27m"));
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[?1006l\x1b[?1002l\x1b[?1000l"));

  clipboard = "terminal-clicked-word-copy";
  t.mock.timers.tick(1200);
  assert.equal(clipboard, "bravo two\ncharlie three\ndelta");
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[?1002h\x1b[?1006h"));

  clipboard = "late-terminal-clicked-word-copy";
  t.mock.timers.tick(100);
  assert.equal(clipboard, "bravo two\ncharlie three\ndelta");

  clipboard = "other-copy";
  assert.deepEqual(inputListener?.("\x1b[<2;5;5M"), { consume: true });
  assert.equal(clipboard, "other-copy");
  t.mock.timers.tick(1200);
  assert.equal(clipboard, "other-copy");
  assert.ok(!tui.render(40)[1]?.includes("\x1b[7mravo two\x1b[27m"));

  compositor.dispose();
});

test("terminal split selection does not expose OSC control sequences as text", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 20;
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const rootLines = [
    "old-0", "old-1", "old-2", "old-3", "old-4",
    "alpha", "bravo", "charlie", "delta", "echo",
    "foxtrot", "golf", "hotel", "india", "\x1b]133;B\x07\x1b]133;C\x07juliet",
  ];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(20);

  assert.deepEqual(inputListener?.("\x1b[<0;1;10M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;6;10M"), { consume: true });
  const selectedLine = tui.render(20).at(-1) ?? "";

  assert.ok(visibleWidth(selectedLine) <= 20);
  assert.ok(!selectedLine.includes("]133"));
  assert.ok(selectedLine.includes("\x1b[7mjulie\x1b[27mt"));

  compositor.dispose();
});

test("terminal split selection highlighting does not duplicate wide glyphs", () => {
  for (const glyph of ["🪃", "👨‍👩‍👧‍👦"]) {
    const terminal = new FakeTerminal();
    terminal.columns = 30;
    let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
    const prefix = "Done shows ";
    const line = `${prefix}${glyph} auto${" ".repeat(30 - visibleWidth(`${prefix}${glyph} auto`))}`;
    const tui = {
      terminal,
      addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
        inputListener = listener;
        return () => {
          inputListener = null;
        };
      },
      requestRender() {},
      render() {
        return ["old-0", "old-1", "old-2", "old-3", "old-4", "old-5", "old-6", "old-7", "old-8", line];
      },
    };

    const compositor = new TerminalSplitCompositor({
      tui,
      terminal,
      renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
    });

    compositor.install();
    tui.render(30);

    const glyphCol = visibleWidth(prefix);
    assert.deepEqual(inputListener?.(`\x1b[<0;${glyphCol + 1};10M`), { consume: true });
    assert.deepEqual(inputListener?.(`\x1b[<32;${glyphCol + 2};10M`), { consume: true });
    const selectedLine = tui.render(30).at(-1) ?? "";

    assert.ok(visibleWidth(selectedLine) <= 30);
    assert.equal(selectedLine.includes(glyph), true);
    assert.ok(selectedLine.includes(`\x1b[7m${glyph}\x1b[27m`));

    compositor.dispose();
  }
});

test("terminal split copies chat and fixed cluster selections", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: string[] = [];
  const rootLines = [
    "old-0", "old-1", "old-2", "old-3", "old-4",
    "alpha one", "bravo two", "charlie three", "delta four", "echo five",
    "foxtrot six", "golf seven", "hotel eight", "india nine", "juliet ten",
  ];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text) => copied.push(text),
    renderCluster: () => ({ lines: ["cluster-a", "  > hello world"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  assert.deepEqual(inputListener?.("\x1b[<0;1;9M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;5;11m"), { consume: true });
  assert.deepEqual(copied, ["india nine\njuli"]);

  assert.deepEqual(inputListener?.("\x1b[<0;5;12M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;10;12M"), { consume: true });
  compositor.requestRepaint();
  assert.ok(terminal.writes.at(-1)?.includes("  > \x1b[7mhello\x1b[27m world"));
  assert.deepEqual(inputListener?.("\x1b[<0;10;12m"), { consume: true });
  assert.deepEqual(copied, ["india nine\njuli", "hello"]);

  assert.deepEqual(inputListener?.("\x1b[<0;8;12M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;8;12m"), { consume: true });
  assert.deepEqual(copied, ["india nine\njuli", "hello"]);

  assert.deepEqual(inputListener?.("\x1b[<0;4;3M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;4;3m"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;5;3M"), { consume: true });
  assert.ok(tui.render(40)[2]?.includes("\x1b[7mcharlie three\x1b[27m"));
  assert.deepEqual(inputListener?.("\x1b[<0;5;3m"), { consume: true });
  assert.deepEqual(copied, ["india nine\njuli", "hello", "charlie three"]);

  assert.deepEqual(inputListener?.("\x1b[<0;8;12M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;8;12m"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;9;12M"), { consume: true });
  compositor.requestRepaint();
  assert.ok(terminal.writes.at(-1)?.includes("\x1b[7m  > hello world\x1b[27m"));
  assert.deepEqual(inputListener?.("\x1b[<0;9;12m"), { consume: true });
  assert.deepEqual(copied, ["india nine\njuli", "hello", "charlie three", "  > hello world"]);

  compositor.dispose();
});

test("terminal split with autoCopyOnSelect disabled keeps selection, shows hint, and copies via ctrl+c", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: Array<{ text: string; source: string }> = [];
  const rootLines = [
    "old-0", "old-1", "old-2", "old-3", "old-4",
    "alpha one", "bravo two", "charlie three", "delta four", "echo five",
    "foxtrot six", "golf seven", "hotel eight", "india nine", "juliet ten",
  ];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    autoCopyOnSelect: false,
    onCopySelection: (text, source) => copied.push({ text, source }),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  assert.deepEqual(inputListener?.("\x1b[<0;1;2M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;6;4M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;6;4m"), { consume: true });

  // release does not auto-copy and the selection stays highlighted
  assert.deepEqual(copied, []);
  assert.deepEqual(withoutScrollbar(tui.render(40)).slice(1, 4), [
    "\x1b[7mbravo two\x1b[27m",
    "\x1b[7mcharlie three\x1b[27m",
    "\x1b[7mdelta\x1b[27m four",
  ]);

  // the fixed cluster paints a copy hint while the selection is active
  compositor.requestRepaint();
  assert.ok(terminal.writes.at(-1)?.includes("29 characters selected, ctrl+c to copy"));

  // ctrl+c copies the selection explicitly and clears it
  assert.deepEqual(inputListener?.("\x03"), { consume: true });
  assert.deepEqual(copied, [{ text: "bravo two\ncharlie three\ndelta", source: "explicit" }]);
  assert.ok(!tui.render(40).some((line) => line.includes("\x1b[7m")));
  compositor.requestRepaint();
  assert.ok(!terminal.writes.at(-1)?.includes("characters selected"));

  // ctrl+c without an active selection falls through to the app
  assert.equal(inputListener?.("\x03"), undefined);

  compositor.dispose();
});

test("terminal split with autoCopyOnSelect disabled still copies selection on right-click", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: Array<{ text: string; source: string }> = [];
  const rootLines = [
    "old-0", "old-1", "old-2", "old-3", "old-4",
    "alpha one", "bravo two", "charlie three", "delta four", "echo five",
    "foxtrot six", "golf seven", "hotel eight", "india nine", "juliet ten",
  ];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    autoCopyOnSelect: false,
    onCopySelection: (text, source) => copied.push({ text, source }),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  assert.deepEqual(inputListener?.("\x1b[<0;1;2M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;6;4M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;6;4m"), { consume: true });
  assert.deepEqual(copied, []);

  // right-click inside the selection is an explicit copy
  assert.deepEqual(inputListener?.("\x1b[<2;5;3M"), { consume: true });
  assert.deepEqual(copied, [{ text: "bravo two\ncharlie three\ndelta", source: "explicit" }]);

  compositor.dispose();
});

test("terminal split auto-copies on release by default without showing the hint", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: Array<{ text: string; source: string }> = [];
  const rootLines = [
    "old-0", "old-1", "old-2", "old-3", "old-4",
    "alpha one", "bravo two", "charlie three", "delta four", "echo five",
    "foxtrot six", "golf seven", "hotel eight", "india nine", "juliet ten",
  ];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return rootLines;
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text, source) => copied.push({ text, source }),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  assert.deepEqual(inputListener?.("\x1b[<0;1;2M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;6;4M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<0;6;4m"), { consume: true });

  assert.deepEqual(copied, [{ text: "bravo two\ncharlie three\ndelta", source: "auto" }]);
  compositor.requestRepaint();
  assert.ok(!terminal.writes.at(-1)?.includes("characters selected"));

  compositor.dispose();
});

test("terminal split selection scrolls when dragged to viewport edges", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: string[] = [];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text) => copied.push(text),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render();
  inputListener?.("\x1b[5~");
  assert.equal(withoutScrollbar(tui.render())[0], "line-10");

  assert.deepEqual(inputListener?.("\x1b[<0;1;9M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;5;12M"), { consume: true });
  assert.equal(withoutScrollbar(tui.render())[0], "line-11");
  assert.ok(tui.render()[9]?.includes("\x1b[7mline\x1b[27m-20"));
  assert.deepEqual(inputListener?.("\x1b[<0;5;12m"), { consume: true });
  assert.deepEqual(copied, ["line-18\nline-19\nline"]);

  compositor.jumpToRootBottom();
  assert.equal(withoutScrollbar(tui.render())[0], "line-20");
  assert.deepEqual(inputListener?.("\x1b[<0;1;2M"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[<32;5;1M"), { consume: true });
  assert.equal(stripAnsiForTest(withoutScrollbar(tui.render())[0] ?? ""), "line-19");
  assert.ok(tui.render()[0]?.includes("line\x1b[7m-19\x1b[27m"));
  assert.deepEqual(inputListener?.("\x1b[<0;5;1m"), { consume: true });
  assert.deepEqual(copied, ["line-18\nline-19\nline", "-19\nline-20"]);

  compositor.dispose();
});

test("terminal split copies edge-scrolled selections without waiting for render", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: string[] = [];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text) => copied.push(text),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render();
  inputListener?.("\x1b[5~");
  tui.render();

  inputListener?.("\x1b[<0;1;9M");
  inputListener?.("\x1b[<32;5;12M");
  inputListener?.("\x1b[<0;5;12m");
  assert.deepEqual(copied, ["line-18\nline-19\nline"]);

  inputListener?.("\x1b[<0;1;9M");
  for (let i = 0; i < 9; i++) {
    inputListener?.("\x1b[<32;5;12M");
  }
  inputListener?.("\x1b[<0;5;12m");
  assert.deepEqual(copied.at(-1), [
    "line-19", "line-20", "line-21", "line-22", "line-23",
    "line-24", "line-25", "line-26", "line-27", "line-28", "line",
  ].join("\n"));

  compositor.dispose();
});

test("terminal split maps post-edge-scroll drags against the updated viewport", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const copied: string[] = [];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection: (text) => copied.push(text),
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render();
  inputListener?.("\x1b[5~");
  tui.render();

  inputListener?.("\x1b[<0;1;9M");
  inputListener?.("\x1b[<32;1;12M");
  inputListener?.("\x1b[<32;1;3M");
  inputListener?.("\x1b[<0;5;4m");
  assert.deepEqual(copied, ["-14\nline-15\nline-16\nline-17"]);

  compositor.dispose();
});

test("terminal split keyboard scroll supports Pi page aliases and preserves app shortcuts", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render();

  assert.deepEqual(inputListener?.("\x1b[5~"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[5;9~"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[57421;9u"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[1;9A"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[57419;9u"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[1;9H"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[57423;9u"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[7;9~"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[1;6A"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[57419;6u"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[6;9~"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[57422;9u"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[1;9B"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[57420;9u"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[1;9F"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[57424;9u"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[8;9~"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[1;6B"), { consume: true });
  assert.deepEqual(inputListener?.("\x1b[57420;6u"), { consume: true });
  assert.equal(inputListener?.("\x1b[1;10A"), undefined);
  assert.equal(inputListener?.("\x1b[57419;10u"), undefined);
  assert.equal(inputListener?.("\x1b[1;10B"), undefined);
  assert.equal(inputListener?.("\x1b[57420;10u"), undefined);
  assert.equal(inputListener?.("\x1b[1;10:3A"), undefined);
  assert.equal(inputListener?.("\x1b[57419;10:3u"), undefined);
  assert.equal(inputListener?.("\x1bp"), undefined);
  assert.equal(inputListener?.("\x1bn"), undefined);

  compositor.dispose();
});

test("terminal split keyboard scroll ignores disabled configured shortcuts and aliases", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    keyboardScrollShortcuts: { up: null, down: "ctrl+shift+d" },
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render();

  assert.equal(inputListener?.("\x1b[5~"), undefined);
  assert.equal(inputListener?.("\x1b[5;9~"), undefined);
  assert.equal(inputListener?.("\x1b[1;9A"), undefined);
  assert.deepEqual(inputListener?.("\x1b[100;6u"), { consume: true });

  compositor.dispose();
});

test("terminal split keyboard scroll accepts configured shortcuts", () => {
  const terminal = new FakeTerminal();
  const renderRequests: Array<boolean | undefined> = [];
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    keyboardScrollShortcuts: { up: "ctrl+shift+u", down: "ctrl+shift+d" },
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render();

  assert.equal(inputListener?.("\x1b[1;9A"), undefined);
  assert.deepEqual(inputListener?.("\x1b[117;6u"), { consume: true });
  assert.deepEqual(renderRequests, [undefined]);
  assert.deepEqual(inputListener?.("\x1b[100;6u"), { consume: true });
  assert.deepEqual(renderRequests, [undefined, undefined]);

  compositor.dispose();
});

test("terminal split clears Kitty images when the scroll viewport moves", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render();
  terminal.writes = [];

  assert.deepEqual(inputListener?.("\x1b[5~"), { consume: true });
  assert.equal(terminal.writes.length, 1);
  assert.match(terminal.writes[0] ?? "", /\x1b_Ga=d,d=A,q=2\x1b\\/);

  terminal.writes = [];
  terminal.write("root update");
  assert.doesNotMatch(terminal.writes[0] ?? "", /\x1b_Ga=d,d=A,q=2\x1b\\/);

  compositor.dispose();
});

test("terminal split jumps to previous root target lines", () => {
  const terminal = new FakeTerminal();
  const renderRequests: Array<boolean | undefined> = [];
  const tui = {
    terminal,
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-20", "line-21", "line-22", "line-23", "line-24",
    "line-25", "line-26", "line-27", "line-28", "line-29",
  ]);

  assert.equal(compositor.jumpToPreviousRootTarget([6, 14, 24]), true);
  assert.deepEqual(renderRequests, [undefined]);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-14", "line-15", "line-16", "line-17", "line-18",
    "line-19", "line-20", "line-21", "line-22", "line-23",
  ]);

  assert.equal(compositor.jumpToPreviousRootTarget([6, 14, 24]), true);
  assert.deepEqual(renderRequests, [undefined, undefined]);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-6", "line-7", "line-8", "line-9", "line-10",
    "line-11", "line-12", "line-13", "line-14", "line-15",
  ]);

  assert.equal(compositor.jumpToPreviousRootTarget([6, 14, 24]), false);

  assert.equal(compositor.jumpToNextRootTarget([6, 14, 24]), true);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-14", "line-15", "line-16", "line-17", "line-18",
    "line-19", "line-20", "line-21", "line-22", "line-23",
  ]);

  assert.equal(compositor.jumpToNextRootTarget([6, 14, 24]), true);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-20", "line-21", "line-22", "line-23", "line-24",
    "line-25", "line-26", "line-27", "line-28", "line-29",
  ]);

  assert.equal(compositor.jumpToNextRootTarget([6, 14, 24]), false);

  assert.equal(compositor.jumpToPreviousRootTarget([6, 14, 24]), true);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-14", "line-15", "line-16", "line-17", "line-18",
    "line-19", "line-20", "line-21", "line-22", "line-23",
  ]);
  assert.equal(compositor.jumpToRootBottom(), true);
  assert.deepEqual(withoutScrollbar(tui.render(40)), [
    "line-20", "line-21", "line-22", "line-23", "line-24",
    "line-25", "line-26", "line-27", "line-28", "line-29",
  ]);
  assert.equal(compositor.jumpToRootBottom(), false);
  compositor.dispose();
});

test("terminal split previous root target only moves to older targets", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  assert.deepEqual(withoutScrollbar(tui.render()), [
    "line-20", "line-21", "line-22", "line-23", "line-24",
    "line-25", "line-26", "line-27", "line-28", "line-29",
  ]);
  assert.deepEqual(inputListener?.("\x1b[5~"), { consume: true });
  assert.deepEqual(withoutScrollbar(tui.render()), [
    "line-10", "line-11", "line-12", "line-13", "line-14",
    "line-15", "line-16", "line-17", "line-18", "line-19",
  ]);

  assert.equal(compositor.jumpToPreviousRootTarget([6, 14, 24]), true);
  assert.deepEqual(withoutScrollbar(tui.render()), [
    "line-6", "line-7", "line-8", "line-9", "line-10",
    "line-11", "line-12", "line-13", "line-14", "line-15",
  ]);

  compositor.dispose();
});

test("terminal split can disable mouse reporting for normal selection", () => {
  const terminal = new FakeTerminal();
  let inputListener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null;
  const renderRequests: Array<boolean | undefined> = [];
  const tui = {
    terminal,
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListener = listener;
      return () => {
        inputListener = null;
      };
    },
    requestRender(force?: boolean) {
      renderRequests.push(force);
    },
    render() {
      return Array.from({ length: 15 }, (_, index) => `line-${index}`);
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    mouseScroll: false,
    renderCluster: () => ({ lines: ["cluster-a", "cluster-b"], cursor: null }),
  });

  compositor.install();
  tui.render(40);

  assert.ok(!terminal.writes[0]?.includes("\x1b[?1002h"));
  assert.ok(!terminal.writes[0]?.includes("\x1b[?1006h"));
  assert.deepEqual(inputListener?.("\x1b[<64;1;1M"), undefined);
  assert.deepEqual(inputListener?.("\x1b[A"), undefined);
  assert.deepEqual(inputListener?.("\x1b[5~"), { consume: true });
  assert.deepEqual(renderRequests, [undefined]);

  compositor.dispose();
  assert.ok(!terminal.writes.at(-1)?.includes("\x1b[?1006l"));
  assert.ok(!terminal.writes.at(-1)?.includes("\x1b[?1002l"));
});

test("terminal split cluster-only repaint falls back when root render width changes", () => {
  const terminal = new FakeTerminal();
  terminal.columns = 40;
  let appRenderCalls = 0;
  const rootRenderWidths: number[] = [];
  const tui = {
    terminal,
    render(width: number) {
      rootRenderWidths.push(width);
      return [`root:${width}`, "root-b"];
    },
    doRender() {
      appRenderCalls += 1;
      this.render(this.terminal.columns);
      this.terminal.write("body");
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    canRepaintClusterOnly: () => true,
    renderCluster: (width) => ({ lines: [`cluster:${width}`], cursor: null }),
  });

  compositor.install();
  tui.doRender();
  assert.equal(appRenderCalls, 1);
  assert.deepEqual(rootRenderWidths, [39]);

  terminal.writes = [];
  tui.doRender();
  assert.equal(appRenderCalls, 1);
  assert.equal(rootRenderWidths.length, 1);
  assert.ok(terminal.writes.at(-1)?.includes("cluster:40"));
  assert.ok(!terminal.writes.at(-1)?.includes("body"));

  terminal.columns = 30;
  terminal.writes = [];
  tui.doRender();
  assert.equal(appRenderCalls, 2);
  assert.deepEqual(rootRenderWidths, [39, 29]);
  assert.ok(terminal.writes.some((write) => write.includes("body")));
  assert.ok(terminal.writes.at(-1)?.includes("cluster:30"));

  compositor.dispose();
});

test("terminal split cluster-only repaint falls back when root render is requested", () => {
  const terminal = new FakeTerminal();
  let rootLines = ["old-root", "root-b"];
  let appRenderCalls = 0;
  const tui = {
    terminal,
    renderRequested: false,
    render() {
      return rootLines;
    },
    doRender() {
      appRenderCalls += 1;
      this.renderRequested = false;
      this.render(this.terminal.columns);
      this.terminal.write("body");
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    canRepaintClusterOnly: () => true,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  tui.doRender();
  assert.equal(appRenderCalls, 1);

  terminal.writes = [];
  rootLines = ["new-root", "root-b"];
  tui.renderRequested = true;
  tui.doRender();

  assert.equal(appRenderCalls, 2);
  assert.equal(tui.renderRequested, false);
  assert.ok(terminal.writes.some((write) => write.includes("body")));

  compositor.dispose();
});

test("terminal split reuses the fixed cluster during one render pass", () => {
  const terminal = new FakeTerminal();
  let renderClusterCount = 0;
  const tui = {
    terminal,
    hardwareCursorRow: 0,
    cursorRow: 0,
    previousViewportTop: 0,
    render() {
      return ["root-a", "root-b"];
    },
    doRender() {
      void this.terminal.rows;
      this.render(this.terminal.columns);
      this.terminal.write("body");
    },
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    renderCluster: () => {
      renderClusterCount += 1;
      return { lines: ["cluster-a", "cluster-b"], cursor: null };
    },
  });

  compositor.install();
  tui.doRender();

  assert.equal(renderClusterCount, 1);

  compositor.dispose();
});

test("emergency terminal reset exits alternate screen before clearing keyboard modes", () => {
  const cleanup = emergencyTerminalModeReset();
  assert.ok(cleanup.includes("\x1b[?1049l"));
  assert.ok(cleanup.includes("\x1b[<999u"));
  assert.ok(cleanup.includes("\x1b[>4;0m"));
  assert.ok(cleanup.indexOf("\x1b[?1049l") < cleanup.indexOf("\x1b[<999u"));
});

test("terminal split emergency exit cleanup resets extended keyboard modes", () => {
  const terminal = new FakeTerminal();
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  process.emit("exit", 0);

  const cleanup = terminal.writes.at(-1) ?? "";
  assert.ok(cleanup.includes("\x1b[<999u"));
  assert.ok(cleanup.includes("\x1b[>4;0m"));
  assert.ok(cleanup.indexOf("\x1b[?1049l") < cleanup.indexOf("\x1b[<999u"));

  compositor.dispose();
});

test("terminal split unregisters emergency exit cleanup on dispose", () => {
  const terminal = new FakeTerminal();
  const before = process.listenerCount("exit");
  const compositor = new TerminalSplitCompositor({
    tui: { terminal },
    terminal,
    renderCluster: () => ({ lines: ["cluster"], cursor: null }),
  });

  compositor.install();
  assert.equal(process.listenerCount("exit"), before + 1);

  compositor.dispose();
  assert.equal(process.listenerCount("exit"), before);
});
