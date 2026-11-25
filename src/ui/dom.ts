/**
 * Builds elements with text nodes only. Nothing in the game ever goes through innerHTML,
 * so a name, a seed or a save file can never inject markup.
 */
type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
  [attr: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "on") {
        for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
      } else if (k === "class") {
        el.className = String(v);
      } else if (k === "style" && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v as Record<string, string>)) el.style.setProperty(sk, sv);
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

/** Stored values may be missing, blocked or edited by hand: every access is guarded. */
export const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): boolean {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  },
};
