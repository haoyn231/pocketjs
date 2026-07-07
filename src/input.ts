// Input: button edge-detection + the focus manager.
//
// Focus model (v1, no layout access from JS [R]):
//   - Default traversal order = DOCUMENT ORDER over the mirror tree, derived
//     lazily (a DFS per navigation press — cheap for UI-sized trees, always
//     correct after <For> reorders).
//   - FocusGrid can override traversal inside a subtree with row/column d-pad
//     semantics; outside a grid, DOWN/RIGHT → next and UP/LEFT → previous.
//   - CIRCLE fires onPress of the focused node, bubbling up to the nearest
//     ancestor with a handler.
//   - Focus loss on removal [R]: next sibling subtree → previous sibling
//     subtree → nearest focusable ancestor → none. Computed BEFORE the mirror
//     unlink (renderer calls notifyDetached first).
//   - Every focus change calls ops.setFocus so the native core applies the
//     `focus:` style variant with zero further JS.

import { BTN } from "../spec/spec.ts";
import { getOps, type PointerPhase, type PointerSource } from "./host.ts";
import type { NodeMirror } from "./renderer.ts";

export interface PointerEvent {
  source: PointerSource;
  phase: PointerPhase | "longpress";
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  button: number;
  buttons: number;
  target: NodeMirror;
  currentTarget: NodeMirror;
  inside: boolean;
}

export type PointerHandler = (event: PointerEvent) => void;

let root: NodeMirror | null = null;
let focused: NodeMirror | null = null;
let prevButtons = 0;
let frameIndex = 0;
const focusScopeStack: NodeMirror[] = [];
const focusGridStack: FocusGridRegistration[] = [];
const activePointers = new Map<number, ActivePointer>();

const LONG_PRESS_FRAMES = 30;
const POINTER_SLOP_PX = 8;

interface ActivePointer {
  source: PointerSource;
  id: number;
  target: NodeMirror;
  pressTarget: NodeMirror | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  button: number;
  buttons: number;
  downFrame: number;
  canceled: boolean;
  longFired: boolean;
}

/** Bind the focus manager to a mirror tree root (index.ts render()). */
export function setInputRoot(r: NodeMirror | null): void {
  root = r;
  focused = null;
  prevButtons = 0;
  frameIndex = 0;
  focusScopeStack.length = 0;
  focusGridStack.length = 0;
  activePointers.clear();
}

/** Tests: forget focus + edge state. */
export function resetInput(): void {
  setInputRoot(null);
}

// ---- registries (renderer setProperty dispatch targets) --------------------

export function registerPress(
  node: NodeMirror,
  fn: (() => void) | undefined | null,
): void {
  node.onPress = fn ?? undefined;
}

export function registerPointerHandler(
  node: NodeMirror,
  name:
    | "onPointerDown"
    | "onPointerMove"
    | "onPointerUp"
    | "onPointerCancel"
    | "onLongPress",
  fn: PointerHandler | undefined | null,
): void {
  node[name] = fn ?? undefined;
}

export function registerFocusable(node: NodeMirror, on: boolean): void {
  node.focusable = on;
  if (!on && focused === node) {
    focusNode(null);
  }
}

// ---- focus ------------------------------------------------------------------

/** Programmatic focus (also used internally). null clears. */
export function focusNode(node: NodeMirror | null): void {
  focused = node;
  getOps().setFocus(node ? node.id : 0);
}

export function getFocused(): NodeMirror | null {
  return focused;
}

function activeFocusRoot(): NodeMirror | null {
  return focusScopeStack.length > 0 ? focusScopeStack[focusScopeStack.length - 1] : root;
}

function collectFocusables(node: NodeMirror, out: NodeMirror[]): void {
  if (!node) return;
  if (node.focusable) out.push(node);
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    collectFocusables(node.children[i], out);
  }
}

function focusables(): NodeMirror[] {
  const out: NodeMirror[] = [];
  const r = activeFocusRoot();
  if (r) collectFocusables(r, out);
  return out;
}

type FocusDirection = "up" | "down" | "left" | "right";

function linearDirection(direction: FocusDirection): 1 | -1 {
  return direction === "down" || direction === "right" ? 1 : -1;
}

function moveLinearFocus(direction: FocusDirection): void {
  const dir = linearDirection(direction);
  const list = focusables();
  if (list.length === 0) {
    if (focused) focusNode(null);
    return;
  }
  const i = focused ? list.indexOf(focused) : -1;
  if (i < 0) {
    // Nothing (validly) focused: enter the order from the direction's end.
    focusNode(dir === 1 ? list[0] : list[list.length - 1]);
    return;
  }
  const j = i + dir;
  if (j < 0 || j >= list.length) return; // clamp at the ends
  focusNode(list[j]);
}

export interface FocusGridOptions {
  columns: number;
  wrap?: boolean;
}

interface FocusGridRegistration {
  node: NodeMirror;
  columns: number;
  wrap: boolean;
}

function activeGrid(): FocusGridRegistration | null {
  if (!focused) return null;
  const active = activeFocusRoot();
  if (active && !isWithin(focused, active)) return null;
  for (let i = focusGridStack.length - 1; i >= 0; i--) {
    const grid = focusGridStack[i];
    if (active && !isWithin(grid.node, active) && !isWithin(active, grid.node)) continue;
    if (isWithin(focused, grid.node)) return grid;
  }
  return null;
}

function moveGridFocus(direction: FocusDirection): boolean {
  const grid = activeGrid();
  if (!grid) return false;

  const list: NodeMirror[] = [];
  collectFocusables(grid.node, list);
  if (list.length === 0) {
    if (focused) focusNode(null);
    return true;
  }

  const columns = grid.columns;
  const i = focused ? list.indexOf(focused) : -1;
  if (i < 0) {
    focusNode(linearDirection(direction) === 1 ? list[0] : list[list.length - 1]);
    return true;
  }

  let j = i;
  switch (direction) {
    case "right":
      if (i + 1 < list.length && i % columns < columns - 1) j = i + 1;
      else if (grid.wrap) j = Math.floor(i / columns) * columns;
      break;
    case "left":
      if (i % columns > 0) j = i - 1;
      else if (grid.wrap) j = Math.min(list.length - 1, Math.floor(i / columns) * columns + columns - 1);
      break;
    case "down":
      if (i + columns < list.length) j = i + columns;
      else if (grid.wrap) j = i % columns;
      break;
    case "up":
      if (i - columns >= 0) j = i - columns;
      else if (grid.wrap) {
        const col = i % columns;
        j = col;
        while (j + columns < list.length) j += columns;
      }
      break;
  }

  if (j !== i) focusNode(list[j]);
  return true;
}

function moveFocus(direction: FocusDirection): void {
  if (moveGridFocus(direction)) return;
  moveLinearFocus(direction);
}

function firePress(): void {
  let n: NodeMirror | null = focused;
  while (n) {
    if (n.onPress) {
      n.onPress();
      return;
    }
    n = n.parent;
  }
}

function firePressAt(node: NodeMirror | null): void {
  let n = node;
  while (n) {
    if (n.onPress) {
      n.onPress();
      return;
    }
    n = n.parent;
  }
}

// ---- removal repair [R] ------------------------------------------------------

function isWithin(node: NodeMirror, ancestor: NodeMirror): boolean {
  if (!node || !ancestor) return false;
  let n: NodeMirror | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

export interface FocusScopeOptions {
  autoFocus?: boolean;
  restoreFocus?: boolean;
}

function firstFocusable(node: NodeMirror): NodeMirror | null {
  if (!node) return null;
  if (node.focusable) return node;
  if (!Array.isArray(node.children)) return null;
  for (let i = 0; i < node.children.length; i++) {
    const f = firstFocusable(node.children[i]);
    if (f) return f;
  }
  return null;
}

function firstFocusableAncestor(node: NodeMirror | null): NodeMirror | null {
  let n = node;
  while (n) {
    if (n.focusable) return n;
    n = n.parent;
  }
  return null;
}

function firstPressAncestor(node: NodeMirror | null): NodeMirror | null {
  let n = node;
  while (n) {
    if (n.onPress || n.onLongPress || n.focusable) return n;
    n = n.parent;
  }
  return null;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function localRect(node: NodeMirror): Rect | null {
  const ops = getOps();
  if (!ops.__layoutX || !ops.__layoutY || !ops.__layoutW || !ops.__layoutH) return null;
  const x = ops.__layoutX(node.id);
  const y = ops.__layoutY(node.id);
  const w = ops.__layoutW(node.id);
  const h = ops.__layoutH(node.id);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function globalRect(node: NodeMirror): Rect | null {
  const own = localRect(node);
  if (!own) return null;
  let x = own.x;
  let y = own.y;
  const w = own.w;
  const h = own.h;
  let n: NodeMirror | null = node;
  n = n.parent;
  while (n) {
    const r = localRect(n);
    if (r) {
      x += r.x;
      y += r.y;
    }
    n = n.parent;
  }
  return { x, y, w, h };
}

function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}

function containsPoint(node: NodeMirror | null, x: number, y: number): boolean {
  if (!node) return false;
  const rect = globalRect(node);
  return !!rect && rectContains(rect, x, y);
}

function pointerSearchRoot(): NodeMirror | null {
  return root?.parent ?? root;
}

function isPointerRelevant(node: NodeMirror): boolean {
  return !!(
    node.focusable ||
    node.onPress ||
    node.onPointerDown ||
    node.onPointerMove ||
    node.onPointerUp ||
    node.onPointerCancel ||
    node.onLongPress
  );
}

function hitTestNode(node: NodeMirror, x: number, y: number): NodeMirror | null {
  const rect = globalRect(node);
  if (rect && !rectContains(rect, x, y)) return null;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const hit = hitTestNode(node.children[i], x, y);
    if (hit) return hit;
  }
  return rect && isPointerRelevant(node) ? node : null;
}

export function hitTestPointer(x: number, y: number): NodeMirror | null {
  const r = pointerSearchRoot();
  return r ? hitTestNode(r, x, y) : null;
}

function dispatchPointer(
  name:
    | "onPointerDown"
    | "onPointerMove"
    | "onPointerUp"
    | "onPointerCancel"
    | "onLongPress",
  target: NodeMirror,
  pointer: ActivePointer,
  phase: PointerEvent["phase"],
  inside: boolean,
): void {
  let n: NodeMirror | null = target;
  while (n) {
    const fn = n[name];
    if (fn) {
      fn({
        source: pointer.source,
        phase,
        id: pointer.id,
        x: pointer.x,
        y: pointer.y,
        startX: pointer.startX,
        startY: pointer.startY,
        button: pointer.button,
        buttons: pointer.buttons,
        target,
        currentTarget: n,
        inside,
      });
    }
    n = n.parent;
  }
}

function pointerMovedPastSlop(pointer: ActivePointer): boolean {
  const dx = pointer.x - pointer.startX;
  const dy = pointer.y - pointer.startY;
  return dx * dx + dy * dy > POINTER_SLOP_PX * POINTER_SLOP_PX;
}

export function handlePointer(
  source: PointerSource,
  phase: PointerPhase,
  id: number,
  x: number,
  y: number,
  button = 0,
  buttons = 0,
): void {
  if (!root) return;
  if (phase === "down") {
    const target = hitTestPointer(x, y);
    if (!target) return;
    const focusTarget = firstFocusableAncestor(target);
    if (focusTarget) focusNode(focusTarget);
    const pointer: ActivePointer = {
      source,
      id,
      target,
      pressTarget: firstPressAncestor(target),
      startX: x,
      startY: y,
      x,
      y,
      button,
      buttons,
      downFrame: frameIndex,
      canceled: false,
      longFired: false,
    };
    activePointers.set(id, pointer);
    dispatchPointer("onPointerDown", target, pointer, "down", true);
    return;
  }

  const pointer = activePointers.get(id);
  if (!pointer) {
    if (phase === "move") {
      const target = hitTestPointer(x, y);
      if (target) {
        const hover: ActivePointer = {
          source,
          id,
          target,
          pressTarget: null,
          startX: x,
          startY: y,
          x,
          y,
          button,
          buttons,
          downFrame: frameIndex,
          canceled: false,
          longFired: false,
        };
        dispatchPointer("onPointerMove", target, hover, "move", true);
      }
    }
    return;
  }

  pointer.x = x;
  pointer.y = y;
  pointer.button = button;
  pointer.buttons = buttons;
  const inside = containsPoint(pointer.pressTarget ?? pointer.target, x, y);
  if (!inside || pointerMovedPastSlop(pointer)) pointer.canceled = true;

  if (phase === "move") {
    dispatchPointer("onPointerMove", pointer.target, pointer, "move", inside);
    return;
  }
  if (phase === "cancel") {
    pointer.canceled = true;
    dispatchPointer("onPointerCancel", pointer.target, pointer, "cancel", inside);
    activePointers.delete(id);
    return;
  }
  if (phase === "up") {
    dispatchPointer("onPointerUp", pointer.target, pointer, "up", inside);
    if (!pointer.canceled && !pointer.longFired && inside) {
      firePressAt(pointer.pressTarget);
    }
    activePointers.delete(id);
  }
}

function updateLongPresses(): void {
  for (const pointer of activePointers.values()) {
    if (pointer.longFired || pointer.canceled || !pointer.pressTarget?.onLongPress) continue;
    if (frameIndex - pointer.downFrame < LONG_PRESS_FRAMES) continue;
    if (!containsPoint(pointer.pressTarget, pointer.x, pointer.y)) {
      pointer.canceled = true;
      continue;
    }
    pointer.longFired = true;
    dispatchPointer("onLongPress", pointer.pressTarget, pointer, "longpress", true);
  }
}

/** Temporarily restrict d-pad traversal and CIRCLE press to a subtree. */
export function pushFocusScope(node: NodeMirror, opts: FocusScopeOptions = {}): () => void {
  const previous = focused;
  focusScopeStack.push(node);
  if (opts.autoFocus !== false && (!focused || !isWithin(focused, node))) {
    focusNode(firstFocusable(node));
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = focusScopeStack.lastIndexOf(node);
    if (i >= 0) focusScopeStack.splice(i, 1);

    const active = activeFocusRoot();
    if (opts.restoreFocus !== false && previous && (!active || isWithin(previous, active))) {
      focusNode(previous);
      return;
    }
    if (active && (!focused || !isWithin(focused, active))) {
      focusNode(firstFocusable(active));
    } else if (!active && focused) {
      focusNode(null);
    }
  };
}

/** Temporarily give a subtree row/column d-pad traversal semantics. */
export function pushFocusGrid(node: NodeMirror, opts: FocusGridOptions): () => void {
  const registration: FocusGridRegistration = {
    node,
    columns: Math.max(1, Math.floor(opts.columns)),
    wrap: opts.wrap ?? false,
  };
  focusGridStack.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = focusGridStack.lastIndexOf(registration);
    if (i >= 0) focusGridStack.splice(i, 1);
  };
}

/**
 * Called by the renderer's removeNode BEFORE the mirror unlink. If the focused
 * node is inside the removed subtree, refocus: next sibling subtree → previous
 * sibling subtree → nearest focusable ancestor → none.
 */
export function notifyDetached(node: NodeMirror): void {
  if (!focused || !isWithin(focused, node)) return;
  const parent = node.parent;
  if (parent) {
    const idx = parent.children.indexOf(node);
    for (let i = idx + 1; i < parent.children.length; i++) {
      const f = firstFocusable(parent.children[i]);
      if (f) {
        focusNode(f);
        return;
      }
    }
    for (let i = idx - 1; i >= 0; i--) {
      const f = firstFocusable(parent.children[i]);
      if (f) {
        focusNode(f);
        return;
      }
    }
    let a: NodeMirror | null = parent;
    while (a) {
      if (a.focusable) {
        focusNode(a);
        return;
      }
      a = a.parent;
    }
  }
  focusNode(null);
}

// ---- per-frame entry ----------------------------------------------------------

/**
 * Edge-detect the button bitmask (spec BTN) and run navigation/press. Called
 * once per frame from globalThis.frame (index.ts) before the renderer sweep.
 */
export function handleFrame(buttons: number): void {
  frameIndex++;
  updateLongPresses();
  const pressed = buttons & ~prevButtons;
  prevButtons = buttons;
  if (pressed === 0) return;
  if (pressed & BTN.DOWN) moveFocus("down");
  if (pressed & BTN.RIGHT) moveFocus("right");
  if (pressed & BTN.UP) moveFocus("up");
  if (pressed & BTN.LEFT) moveFocus("left");
  if (pressed & BTN.CIRCLE) firePress();
}
