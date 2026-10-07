# 实际实现与任务路径

## 主路径

```text
用户目标 / 工作区 / 附件
    → CLI 材料与会话组织
    → 规则选择任务策略，构造科研方法上下文
    → 流式模型请求
    → 工具参数分片合并
    → 真实文件 / 命令 / MCP 工具执行
    → 工具结果回填消息
    → 下一轮模型动作或最终回答
```

策略决定工作方式，不强制所有科研任务经过同一张阶段图。角色职责可以由同一个模型在多轮执行中承担，但这不能证明原搜索或候选进化机制已等价实现。

## 可定位的实现

| 职责 | 文件与函数 | 实际边界 |
|---|---|---|
| 命令行入口 | `src/cli.ts::main/runTurn` | 单次任务和连续交互，共用 CLI 工具循环 |
| 意图与策略 | `src/core/decision.ts::decideAgentLoop` | 目标、附件覆盖信息及关键词的规则决策，不是测得准确率的分类器 |
| 策略注入 | `src/core/sessionRuntime.ts::createDecisionPrompt/createAgentMessages` | 策略、理由、能力与验证要求进入上下文，不是模型内部 thinking 开关 |
| 流式循环 | `src/core/chatStreamRuntime.ts::runStreamingToolLoop` | 合并工具参数，执行工具，结果回填，最多64轮；可因端点能力或工具失败提前结束 |
| 实际工具 | `src/core/agenticTools.ts::executeRuntimeTool` | `cog_read/cog_write/cog_edit/cog_bash` 等真正读写和执行；不是仅输出建议 |
| 科研能力目录 | `src/core/skills.ts` | 名称、触发、目的和预期产物；不能单凭目录声称所有方法已可运行 |
| Skills / MCP | `skillRuntime.ts/capabilityRuntime.ts/mcpClient.ts` | 工作区发现、安装和动态工具接入；服务可用性需另行配置 |
| 材料与记忆 | `localIntake.ts/sessionRuntime.ts/memoryManager.ts` | 附件、近期对话及摘要组织；不等于无损无限长记忆 |

文件、会话和记录保存在对应工作区的 `artifacts/`、`.cogclaw/` 等目录。请自行管理数据与模型费用，别把这个最小本地程序当成完整沙箱或生产级托管服务。

## 发行范围

只复制 `src/cli.ts` 的42个可达源码文件及能力配置，移除网页与不必要前端依赖；源码字节摘要见 `source-manifest.json`。内部CLI品牌及协议名称不做全仓替换，以免使发布包装混同于被评测实现的功能变化。

包的 `build/check` 只做类型检查，不构建网页。Python用于科研任务时由模型调用工作区命令，模型循环仍是当前原生实现；此包不声称迁移到其他Runtime。
