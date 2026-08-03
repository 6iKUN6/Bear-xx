# @litter-bear/assets

前后端共享的静态资产包。构建工具（Vite / Taro）通过子路径直接 import，由各端自己的资产管线处理打包与指纹。

```ts
import defaultAgentAvatar from "@litter-bear/assets/agents/default-avatar.png";
```

## 资产清单

| 路径 | 用途 | 来源 / 许可 |
| --- | --- | --- |
| `agents/default-avatar.png` | 智能体默认头像（`Agent.avatar` 为空时的兜底展示） | [DiceBear Bottts](https://www.dicebear.com/styles/bottts/)（`seed=bear`），Bottts 由 Pablo Stanley 设计，个人与商业使用免费 |
