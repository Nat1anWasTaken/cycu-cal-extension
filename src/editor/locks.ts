// Locked ("forbidden") regions, mirroring the site's Ace keyboard guard.
//
// Site rule (Ace, 0-indexed, fixed coordinates — not anchors): an edit is rejected when the
// selection intersects a lock AND the selection start is before the lock end; Backspace with an
// empty selection exactly at the lock end is also rejected. Typing *at* the lock end (e.g. Enter
// to start a new line below a locked block) is allowed.
//
// Enforcement layers in Monaco:
//   1. keydown / beforeinput / paste / cut interception using the rule above (all cursors);
//   2. safety net: onDidChangeModelContent reverts any change whose replaced range touches a lock
//      (covers commands, undo/redo, context-menu paste, drag & drop, multi-cursor, IME — deferred until the
//      composition ends).

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type { LockRange } from '../shared/protocol';
import { setModelText } from './monaco-setup';

type IRange = Monaco.IRange;
type IPosition = Monaco.IPosition;

/** Ace {row,column} (0-based) → Monaco 1-based position. Huge/Infinity columns compare correctly. */
function startOf(l: LockRange): IPosition {
  return { lineNumber: l.start.row + 1, column: l.start.column + 1 };
}
function endOf(l: LockRange): IPosition {
  return { lineNumber: l.end.row + 1, column: l.end.column + 1 };
}
function cmp(a: IPosition, b: IPosition): number {
  return a.lineNumber - b.lineNumber || a.column - b.column;
}

/**
 * True when an edit replacing `range` (Monaco coordinates, an empty range is a caret) is forbidden:
 * it intersects (touching counts) a lock and starts before that lock's end.
 */
export function touchesLock(range: IRange, locks: readonly LockRange[]): boolean {
  const s = { lineNumber: range.startLineNumber, column: range.startColumn };
  const e = { lineNumber: range.endLineNumber, column: range.endColumn };
  return locks.some((l) => cmp(e, startOf(l)) >= 0 && cmp(s, endOf(l)) < 0);
}

/** True when typing at `pos` (empty selection) would be rejected. */
export function isPositionLocked(pos: IPosition, locks: readonly LockRange[]): boolean {
  return touchesLock(
    { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column },
    locks,
  );
}

/** True when `pos` is exactly at a lock end (where Backspace is rejected). */
export function isAtLockEnd(pos: IPosition, locks: readonly LockRange[], model?: Monaco.editor.ITextModel): boolean {
  return locks.some((l) => {
    const end = model ? model.validatePosition(endOf(l)) : endOf(l);
    return cmp(pos, end) === 0;
  });
}

export interface LockGuard {
  setLocks(locks: LockRange[]): void;
  getLocks(): LockRange[];
  /** Runs `fn` (e.g. applying text that came from Ace) without the safety net, then re-baselines. */
  runUnguarded(fn: () => void): void;
  dispose(): void;
}

const EDIT_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete']);

export function installLockGuard(
  monaco: typeof Monaco,
  ed: Monaco.editor.IStandaloneCodeEditor,
  initial: LockRange[],
): LockGuard {
  const model = ed.getModel()!;
  let locks = initial.slice();
  let shadow = model.getValue(); // last text that respected the locks
  let unguarded = 0;
  let composing = false;
  let violatedDuringComposition = false;
  let reverting = false;
  const disposables: Monaco.IDisposable[] = [];
  const decorations = ed.createDecorationsCollection();

  const redecorate = () => {
    decorations.set(
      locks.map((l) => ({
        range: model.validateRange(
          new monaco.Range(l.start.row + 1, l.start.column + 1, l.end.row + 1, l.end.column + 1),
        ),
        options: {
          isWholeLine: true,
          className: 'cal-locked-line',
          marginClassName: 'cal-locked-margin',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  };

  const selectionsBlocked = (backspace: boolean): boolean => {
    if (!locks.length) return false;
    const sels = ed.getSelections() ?? [];
    return sels.some(
      (s) => touchesLock(s, locks) || (backspace && s.isEmpty() && isAtLockEnd(s.getPosition(), locks, model)),
    );
  };

  const revert = (e?: Monaco.editor.IModelContentChangedEvent) => {
    reverting = true;
    try {
      const sels = ed.getSelections();
      if (e) {
        if (e.isUndoing) model.redo();
        else if (e.isRedoing) model.undo();
        else model.undo();
      }
      if (model.getValue() !== shadow) setModelText(model, shadow, sels);
      if (sels?.length) {
        ed.setSelections(
          sels.map((x) => {
            const a = model.validatePosition(x.getSelectionStart());
            const b = model.validatePosition(x.getPosition());
            return new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column);
          }),
        );
      }
    } finally {
      reverting = false;
    }
  };

  disposables.push(
    model.onDidChangeContent((e) => {
      if (reverting) return;
      if (unguarded > 0 || e.isFlush) {
        shadow = model.getValue();
        redecorate();
        return;
      }
      const bad = locks.length > 0 && e.changes.some((c) => touchesLock(c.range, locks));
      if (!bad) {
        if (!violatedDuringComposition) shadow = model.getValue();
        redecorate();
        return;
      }
      if (composing) {
        violatedDuringComposition = true;
        return;
      }
      // Never mutate the model from inside its own change event.
      queueMicrotask(() => revert(e));
    }),
  );

  disposables.push(
    ed.onKeyDown((e) => {
      if (!locks.length || ed.getOption(monaco.editor.EditorOption.readOnly)) return;
      const be = e.browserEvent;
      const mod = be.ctrlKey || be.metaKey;
      const printable = be.key.length === 1 && !mod;
      const clipboard = mod && !be.altKey && (be.key === 'x' || be.key === 'v' || be.key === 'X' || be.key === 'V');
      if (!printable && !clipboard && !EDIT_KEYS.has(be.key)) return;
      if (selectionsBlocked(be.key === 'Backspace')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }),
  );

  disposables.push(ed.onDidCompositionStart(() => (composing = true)));
  disposables.push(
    ed.onDidCompositionEnd(() => {
      composing = false;
      if (violatedDuringComposition) {
        violatedDuringComposition = false;
        queueMicrotask(() => revert());
      }
    }),
  );

  // DOM-level guards (capture phase, before Monaco's own handlers).
  const dom = ed.getDomNode();
  const domGuard = (ev: Event) => {
    if (!locks.length || ed.getOption(monaco.editor.EditorOption.readOnly)) return;
    if (ev.type === 'beforeinput') {
      const ie = ev as InputEvent;
      if (ie.isComposing || ie.inputType === 'insertCompositionText') return; // IME: safety net
      if (selectionsBlocked(ie.inputType === 'deleteContentBackward')) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
      return;
    }
    if (selectionsBlocked(false)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  };
  const domEvents = ['beforeinput', 'paste', 'cut']; // drops land at the pointer: safety net
  if (dom) for (const t of domEvents) dom.addEventListener(t, domGuard, true);

  redecorate();

  return {
    setLocks(next) {
      locks = next.slice();
      redecorate();
    },
    getLocks: () => locks,
    runUnguarded(fn) {
      unguarded++;
      try {
        fn();
      } finally {
        unguarded--;
        shadow = model.getValue();
        redecorate();
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      decorations.clear();
      if (dom) for (const t of domEvents) dom.removeEventListener(t, domGuard, true);
    },
  };
}
