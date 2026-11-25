import { Player } from "./app.js";

declare const __BUILTIN_PACKS__: string[];

const root = document.getElementById("app");
if (root) {
  void new Player(root, __BUILTIN_PACKS__).start();
}
// Offline: the service worker keeps a copy of the app. Absent or refused (a preview frame), the game still runs online.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && window.top === window.self) {
  navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}
