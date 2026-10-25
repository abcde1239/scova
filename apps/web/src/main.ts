import { createApp, h } from "vue";
import "@/style.css";

// M1 仅建立可启动的 Vue 入口，业务工作台由后续 Issue 实现。
createApp({
  render: () =>
    h("main", { id: "center" }, [
      h("h1", "知巡 Scova"),
      h("p", "任务驱动的 AI 信息查阅与研究工作台"),
      h("p", "工程入口已建立，业务页面正在开发。"),
    ]),
}).mount("#app");
