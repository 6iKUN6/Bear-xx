export default defineAppConfig({
  pages: [
    "pages/index/index",
    "pages/chat/index",
    "pages/agents/index",
    "pages/agent-picker/index",
    "pages/image/index",
    "pages/profile/index",
    "pages/login/index",
    "pages/settings/theme/index",
  ],
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#F3F5F9",
    navigationBarTitleText: "Litter Bear",
    navigationBarTextStyle: "black",
    navigationStyle: "custom",
  },
});
