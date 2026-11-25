import { App } from "./ui/app.js";

const root = document.getElementById("app");
if (root) {
  const app = new App(root);
  app.start();
}
