const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// 使用真实 store 实现与 Zustand，仅替换网络/持久化边界，无需启动服务。
exports.loadStore = (file, dependencies) => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/renderer/src", file),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const result = {};
  const importDependency = (id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    return require(id);
  };
  new Function("require", "exports", output.outputText)(
    importDependency,
    result,
  );
  return result;
};
