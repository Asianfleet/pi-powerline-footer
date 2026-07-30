# Fixed Editor Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 fixed-editor 模式的聊天视口右侧实现类似 Reasonix CLI 的应用内滚动条。

**Architecture:** 复用 `TerminalSplitCompositor` 已有的 `rootLines`、`visibleRootStart`、`visibleScrollableRows`、`scrollOffset` 和 `maxScrollOffset`。聊天内容渲染宽度减少 1 列，最后一列绘制 track/thumb；鼠标点击和拖动滚动条时反算 viewport offset，并转换成本项目的 bottom-relative `scrollOffset`。

**Tech Stack:** TypeScript, Node test runner, `@earendil-works/pi-tui` ANSI/width helpers.

## Global Constraints

- fixed-editor 继续使用现有 alternate-screen compositor，不恢复终端原生 scrollback。
- 滚动条只占聊天 viewport 的最后一列，不占用底部 editor cluster。
- `scrollOffset = 0` 表示聊天视口在底部；滚动条计算用 `visibleRootStart` 作为 top-relative offset。
- 鼠标滚动条交互只在 `mouseScroll !== false` 时可用。
- 新增函数必须带有说明用途的 doc comment；代码注释使用中文。
- 所有生产代码改动必须先有失败测试。

---

### Task 1: Scrollbar Rendering

**Files:**
- Modify: `fixed-editor/terminal-split.ts`
- Test: `tests/fixed-editor.test.ts`

**Interfaces:**
- Produces: `TerminalSplitCompositor` 在 root viewport 右侧渲染 1 列滚动条。
- Produces: helper 函数 `scrollbarThumb(height: number, yOffset: number, total: number)`，返回 `{ start: number; size: number }`。

- [ ] **Step 1: Write failing tests**

Add tests in `tests/fixed-editor.test.ts` that assert:
- Overflowing root content renders with `│` track cells and `█` thumb cells in the final viewport column.
- At bottom, the thumb is near the bottom.
- After PageUp, the thumb moves upward.
- Non-overflowing content leaves the gutter blank.
- `outputPad` keeps the scrollbar inside the padded content area.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/fixed-editor.test.ts`

Expected: the new scrollbar assertions fail because the compositor does not render a scrollbar.

- [ ] **Step 3: Implement minimal rendering**

In `fixed-editor/terminal-split.ts`:
- Add scrollbar constants for thumb and track.
- Add `scrollbarThumb`.
- Add methods on `TerminalSplitCompositor` to compute body width, decide overflow, and append a scrollbar cell.
- Update `renderVisibleRootLines` so scroll-away card layout uses body width, then appends the scrollbar cell before `insetLine`.
- When scrollbar is enabled, disable the `canShiftRows` optimized branch in `repaintScrollableViewport` to avoid stale scrolled gutter cells.

- [ ] **Step 4: Run task tests**

Run: `npm test -- tests/fixed-editor.test.ts`

Expected: new and existing fixed-editor tests pass.

### Task 2: Scrollbar Mouse Interaction

**Files:**
- Modify: `fixed-editor/terminal-split.ts`
- Test: `tests/fixed-editor.test.ts`

**Interfaces:**
- Consumes: Task 1 scrollbar layout helpers.
- Produces: scrollbar click/drag updates `scrollOffset` without starting text selection.

- [ ] **Step 1: Write failing tests**

Add tests in `tests/fixed-editor.test.ts` that assert:
- Left click on the scrollbar jumps the root viewport to the corresponding region.
- Dragging the scrollbar updates the visible root lines.
- Releasing the mouse ends scrollbar drag.
- Clicking scrollbar does not create or copy a text selection.
- With `mouseScroll: false`, SGR mouse packets are not consumed.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/fixed-editor.test.ts`

Expected: new interaction tests fail because scrollbar mouse packets are not handled.

- [ ] **Step 3: Implement minimal interaction**

In `TerminalSplitCompositor`:
- Add `scrollbarDragging` and `scrollbarGrabOffset` fields.
- Add helpers to detect the scrollbar terminal column, compute grab offset, convert mouse row to `visibleRootStart`, and then convert that to `scrollOffset`.
- In `handleMousePacket`, process scrollbar press/drag/release before selection handling.
- Clear active text selection when a scrollbar drag starts.

- [ ] **Step 4: Run task tests**

Run: `npm test -- tests/fixed-editor.test.ts`

Expected: fixed-editor tests pass.

### Task 3: Configuration and Documentation

**Files:**
- Modify: `types.ts`
- Modify: `powerline-config.ts`
- Modify: `index.ts`
- Modify: `README.md`
- Test: `tests/custom-items.test.ts`
- Test: `tests/jump-shortcuts.test.ts`

**Interfaces:**
- Produces: `powerline.scrollbar` boolean setting, default `true`.
- Consumes: `TerminalSplitCompositorOptions.scrollbar`.

- [ ] **Step 1: Write failing tests**

Add tests that assert:
- `parsePowerlineConfig` defaults `scrollbar` to `true`.
- `parsePowerlineConfig` accepts `scrollbar: false`.
- `nextPowerlineSettingWithOptions` can persist `scrollbar`.
- `index.ts` passes `config.scrollbar` into `TerminalSplitCompositor`.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/custom-items.test.ts tests/jump-shortcuts.test.ts`

Expected: tests fail because `scrollbar` is not in config types/parsing or compositor options.

- [ ] **Step 3: Implement config and docs**

Update:
- `PowerlineConfig` with `scrollbar: boolean`.
- defaults to `true`.
- settings writer option type to include `scrollbar`.
- `/powerline` command help only if existing command pattern has a natural option branch; otherwise document settings-only in README.
- `installFixedEditorCompositor` passes `scrollbar: config.scrollbar`.
- README fixed-editor section documents the scrollbar and `powerline.scrollbar`.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/custom-items.test.ts tests/jump-shortcuts.test.ts tests/fixed-editor.test.ts`

Expected: targeted tests pass.

### Task 4: Final Verification

**Files:**
- No production edits unless tests expose an integration defect.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: verified final diff.

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Inspect final diff**

Run: `git diff --stat` and `git diff --check`

Expected: diff contains only scrollbar feature changes and no whitespace errors.

- [ ] **Step 3: Final code review**

Dispatch a reviewer against the full branch diff. Fix Critical and Important findings before completion.
