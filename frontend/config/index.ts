import { resolve } from "node:path";
import { defineConfig, type UserConfigExport } from "@tarojs/cli";
import tailwindcssPostcss from "@tailwindcss/postcss";
import AutoImport from "unplugin-auto-import/vite";
import { UnifiedViteWeappTailwindcssPlugin as uvtw } from "weapp-tailwindcss/vite";

import devConfig from "./dev";
import prodConfig from "./prod";

function stabilizeViteCssPipeline() {
  return {
    name: "stabilize-vite-css-pipeline",
    config(config: Record<string, any>) {
      const css = (config.css ??= {});
      const postcss =
        typeof css.postcss === "object" && css.postcss
          ? css.postcss
          : (css.postcss = {});
      const plugins = Array.isArray(postcss.plugins)
        ? postcss.plugins
        : (postcss.plugins = []);
      const tailwindPluginIndex = plugins.findIndex(
        (plugin: { postcssPlugin?: string } | undefined) =>
          plugin?.postcssPlugin === "@tailwindcss/postcss",
      );

      if (tailwindPluginIndex === -1) {
        plugins.unshift(
          tailwindcssPostcss({
            base: process.cwd(),
          }),
        );
      } else if (tailwindPluginIndex > 0) {
        const [tailwindPlugin] = plugins.splice(tailwindPluginIndex, 1);
        plugins.unshift(tailwindPlugin);
      }

      const preprocessorOptions = (css.preprocessorOptions ??= {});
      const sassWarnings = ["import", "global-builtin", "legacy-js-api"];

      for (const syntax of ["scss", "sass"]) {
        const options = (preprocessorOptions[syntax] ??= {});
        const existing = Array.isArray(options.silenceDeprecations)
          ? options.silenceDeprecations
          : [];

        options.api ??= "modern";
        options.quietDeps ??= true;
        options.silenceDeprecations = Array.from(
          new Set([...existing, ...sassWarnings]),
        );
      }
    },
  };
}

function resolveOutputRoot(taroEnv?: string) {
  switch (taroEnv) {
    case "h5":
      return "dist/h5";
    case "weapp":
      return "dist/weapp";
    case "swan":
      return "dist/swan";
    case "alipay":
      return "dist/alipay";
    case "tt":
      return "dist/tt";
    case "qq":
      return "dist/qq";
    case "jd":
      return "dist/jd";
    case "rn":
      return "dist/rn";
    case "harmony":
      return "dist/harmony";
    default:
      return `dist/${taroEnv || "common"}`;
  }
}

// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<"vite">(async (merge) => {
  const taroEnv = process.env.TARO_ENV;
  const baseConfig: UserConfigExport<"vite"> = {
    projectName: "Litter-Bear",
    date: "2026-2-28",
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: "src",
    outputRoot: resolveOutputRoot(taroEnv),
    plugins: ["@tarojs/plugin-generator"],
    defineConstants: {},
    postcss: {
      autoprefixer: {
        enable: true,
        config: {},
      },
      pxtransform: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false,
        config: {
          namingPattern: "module",
          generateScopedName: "[name]__[local]___[hash:base64:5]",
        },
      },
    },
    sassLoaderOption: {
      api: "modern",
      quietDeps: true,
      silenceDeprecations: ["import", "global-builtin", "legacy-js-api"],
    },
    copy: {
      patterns: [],
      options: {},
    },
    framework: "react",
    compiler: {
      type: "vite",
      vitePlugins: [
        stabilizeViteCssPipeline(),
        AutoImport({
          imports: [
            {
              "@tarojs/taro": [["default", "Taro"]],
            },
          ],
          dts: "types/auto-imports.d.ts",
        }),
        uvtw({
          cssEntries: [resolve(process.cwd(), "src/app.css")],
          rem2rpx: process.env.TARO_ENV !== "h5",
          disabled:
            process.env.TARO_ENV === "harmony" || process.env.TARO_ENV === "rn",
          injectAdditionalCssVarScope: true,
        }),
      ],
    },
    mini: {},
    h5: {
      publicPath: "/",
      staticDirectory: "static",
      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: "css/[name].[hash].css",
        chunkFilename: "css/[name].[chunkhash].css",
      },
    },
    rn: {
      appName: "taroDemo",
    },
  };

  if (process.env.NODE_ENV === "development") {
    // 本地开发构建配置（不混淆压缩）
    return merge({}, baseConfig, devConfig);
  }
  // 生产构建配置（默认开启压缩混淆等）
  return merge({}, baseConfig, prodConfig);
});
