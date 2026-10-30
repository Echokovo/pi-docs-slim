# @ssk_dev/pi-docs-slim

> [看看我的完整 Pi 配置](https://github.com/kunkun9527/my-lean-pi-setup)

[English](README.md)

一个 [Pi](https://pi.dev) 扩展，把 Pi 默认附带的文档说明从系统提示词里去掉。真要问 Pi 本身的问题时，用 `/pi` 提问，这一次会把文档说明带回来。

本项目 fork 自 Rob Zolkos 的 [robzolkos/pi-slim](https://github.com/robzolkos/pi-slim)。思路和 `/pi` 命令都来自原版，fork 主要是为了让它能在新版 Pi 上正常工作。

## 安装

```bash
pi install npm:@ssk_dev/pi-docs-slim
```

如果装过原版 `pi-slim`，先卸载。两个扩展都会注册 `/pi` 命令。

需要 Pi 0.87.1 或更新版本（已在 0.87.1、1.0.0 和 1.4.0 上测试）。

## 使用

- 普通请求：模型看不到 Pi 的文档说明。
- `/pi <关于 Pi 的问题>`：文档说明改放在这条消息的开头，不再进系统提示词；工具调用的轮次同样带着它；文档说明真正放进请求后，transcript 里这条消息和回复之间会出现一行 `📖 pi-docs` 标记，指出是哪次运行带了它；下一条普通请求恢复清理。
- 你自己写的 `<docs>`、项目指令和代码示例不动；保存下来的用户消息、助手回答和工具输出一律不改（`/pi` 只在发出的请求里加文档说明）。

安装或更新后执行 `/reload`，发一条普通消息，再看看 `/context`。

## 为什么要 fork

原版 0.2.1 靠替换系统提示词里的一段字符串来去掉文档说明。Pi 0.87.1 开始，系统提示词改成按结构化的 section 拼出来，并保存成 system 消息，这种替换就不起作用了，文档说明照样会发给模型（见 [pi-slim#3](https://github.com/robzolkos/pi-slim/issues/3)）。

这个 fork 改了这些：

- **在新的结构化提示词里去掉文档说明。** 不让 Pi 把 docs section 重新填回来，每条请求发出前都会把文档说明去掉。保存下来的 system 消息里会留一个很短的 `<!-- pi-slim:omit -->` 标记：Pi 每次请求都拿 transcript 里的 section 做 diff，如果这里清空，它就会给每条请求追加一条空的 system 消息。
- **旧历史也清理。** 之前 `/pi` 留下的文档说明，在后面的普通请求里会被去掉。
- **`/context` 与加载顺序无关。** 不管 [pi-context-view](https://www.npmjs.com/package/pi-context-view) 排在本扩展之前还是之后，它都不会显示 Pi 文档说明，也不会把提示词误标成 forced（省略标记见“限制”）。
- **`/pi` 更可靠。** “保留文档”的许可只绑定到 `/pi` 发出的那一次请求；就算这次请求被拦截，也不会漏到你的下一条消息。
- **`/pi` 不再打断 prompt cache。** 多数 provider 把系统提示词放在请求最开头，以前把文档说明塞回系统提示词，就得让 provider 把整个会话重新算一遍缓存：一次 `/pi` 连着丢两次（`/pi` 那次，加上后面第一条把文档关掉的普通请求）。现在每条请求的系统提示词完全一致，`/pi` 之前的缓存前缀都保得住。新增的只有 `/pi` 这一轮本身：约 500 token 的文档说明，以及下一条普通请求不再带说明，要把这一轮重新算一次。
- **提示词不会被冻结。** 其他扩展后来加的工具和规则照样生效。
- **加了离线集成测试。** 用真实的 Pi 会话加离线模型 provider 跑，不调用模型服务。

没有新增运行时依赖。

## 测试

```bash
npm test
```

测试需要装好 Pi 0.87.1 以上版本和 pi-context-view 0.6.0 或 0.8.0。默认找全局的 Pi 和 `~/.pi/agent/npm/node_modules/pi-context-view`；装在别处的话，指向包的根目录：

```bash
PI_CODING_AGENT_DIR=/path/to/pi-coding-agent PI_CONTEXT_VIEW_DIR=/path/to/pi-context-view npm test
```

设置 `PI_SLIM_ENTRY` 可以拿这套测试去跑别的实现。

## 限制

- 不改写旧的会话文件。`/context` 的 Usage 视图在下一条普通请求后就是干净的。Initial 视图是第一次请求时的快照，要重新加载才会更新；如果第一次请求用的是 `/pi`，里面有文档说明是正常的。
- `/pi` 运行期间，`/context` 会把文档说明显示成那条消息的内容（约 500 token）。它只加在请求里：保存下来的会话仍是你原样输入的问题，后面的请求也不会带上它。
- `📖 pi-docs` 标记是会话里的一条 `CustomEntry`：Pi 不会把 custom entry 放进模型上下文，所以它不占 prompt token，`/context` 也不会统计它，重新加载后仍然在。它在这次运行的消息保存之后才写入，所以从那条消息 fork 或用 `/tree` 回退时不会带上它，压缩时的切分位置也和没有它时一样。token 数只是粗略估算；排在本扩展之后、还会改请求的扩展仍可能改变实际发出的内容。
- 保存下来的会话会在 `docs` section 里留一个约 20 字符的省略标记，这样 Pi 每次请求的 section diff 才能稳定。标记在每条请求发出前都会去掉，不会发给模型，但 `/context` 可能把它算进去（约 5 token）：pi-context-view 0.6.0 读的是保存的 transcript，0.8.0 排在本扩展之前加载时，会在清理之前截取请求。这是 pi-context-view 对排在它后面的处理器的既定行为（见它的 [capture 文档](https://github.com/dimk90/pi-context-view/blob/develop/doc/architecture/capture.md)），不需要调整加载顺序。
- 模型自己用工具去读 Pi 文档，读到的内容会保留。
- 清理逻辑依赖 Pi 0.87.1 的事件顺序，升级 Pi 后要重跑测试。如果别的扩展在最后一步上下文处理之后又塞回文档说明，这里清不掉。

## 许可证

MIT。原作品版权归 pi-slim contributors（Rob Zolkos）所有，见 [LICENSE](LICENSE)。
