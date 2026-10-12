# ResearchAgent

**面向论文方法实现、数据分析和实验迭代的科研任务智能体。**

ResearchAgent 在通用模型—工具执行底座上，根据用户目标及论文、数据、实验信号选择工作策略，将方法指导、推荐工具和验证要求组织到上下文，再通过实际文件操作与命令执行推进任务。

科研策略是一种按场景使用的工作方式，不是要求每个任务走完固定流水线，也不是模型内部专属推理算法。这个最小发行包只包含真实 CLI 执行路径，不需要启动网页。

## 核心思路与实现

1. **任务意图与科研策略。** 从目标、附件和任务信号选择普通对话、代码工作或科研策略，将选择理由、所需能力、推荐工具和验证要求传给模型。识别采用规则和启发式，未声称训练了意图分类模型。
2. **科研能力组织。** 用包含触发条件、目的和预期产物的能力目录表达数据分析、论文方法实现、复现运行、修复与结果复查职责；支持工作区 Skills 安装与发现、MCP 工具名称与参数映射。能力目录不等于所有科研算法已经完整实现为可执行 Skills。
3. **策略到行动的反馈。** 使用模型—工具多轮循环，拼接流式工具调用参数，调用读取、检索、编辑、写文件与命令工具，再将真实结果和异常回填给模型，供其继续调整实现与后续动作。

项目的能力目标是交付具体方案、功能代码和真实任务结果。会话、权限、记录等只是执行支持，不能代替科研能力或被当成主要创新。

## 安装与启动

要求 Node.js 22 或更高版本、npm，以及能够访问 npm registry。代码执行涉及 Python/训练工具时，还需要在你的任务环境中自行安装对应依赖；这些不是 Agent 本身的安装要求。

```powershell
npm ci
npm run check
npm test
Copy-Item .env.example .env
```

编辑本地 `.env`，填写自己的 OpenAI-compatible endpoint 和 API Key。使用支持流式 tool calling 的模型：

```dotenv
CLAW_MODEL_BASE_URL=https://your-openai-compatible-endpoint.example/v1
CLAW_MODEL_API_KEY=replace-with-your-api-key
```

**不要提交真实密钥。** `default:MODEL_ID` 的模型名应替换为你的服务实际支持的名称。

```powershell
# 连续交互
npm run agent -- --workspace ./examples/research-task --model "default:MODEL_ID"

# 一次任务后退出
npm run agent -- --workspace ./examples/research-task --model "default:MODEL_ID" --once "读取 task.md 和 data.csv，编写汇总程序并执行，输出按组统计结果；说明实现和未运行的部分。"

# 使用你已有的科研工作区和附件
npm run agent -- --workspace "E:\my-research-task" --model "default:MODEL_ID" --attach "E:\my-research-task\paper.md" --once "理解所附论文方法，组织实现方案，在当前工作区编写功能代码，并运行小规模验证。"

# 查看本地会话 / 工作区
npm run cli -- sessions
npm run cli -- workspaces
```

启动时在**发行包根目录**运行这些命令，以便读取该目录下的 `.env`。Shell 工具会执行真实命令，请使用允许 Agent 修改的工作区。模型用量会产生服务费用；本包没有内置全账户预算限制，原评测外层的费用账本也不在本包中。

常见交互命令包括 `/help`、`/status`、`/model`、`/mode auto`、`/mode plan`、`/sessions`、`/workspace` 和 `/compact`。`/quota` 依赖原网页服务，不属于此 CLI 最小包的使用路径。

## 最小示例

`examples/research-task/` 是一个小型 CSV 数据处理任务，包含输入材料和固定检查脚本。先让 Agent 完成任务，再在该工作区独立运行：

```powershell
node verify.mjs
```

这只是易运行的使用示例，不是外部 benchmark，不预填模型任务成功率。`npm test` 则采用离线假模型响应确认 CLI、流式工具参数和真实文件写入能接通，不调用付费模型，不算科研任务成绩。

## 效果与边界

真实能力结果来自固定版本的任务执行，而不是模式名称、Skill 数量或模拟响应。**2026-10-12 更新**：

| 评测 / 实验 | 实际结果 | 适用范围 |
|---|---|---|
| PaperBench Code-Dev 官方 `all.txt` 全部20篇 | 每篇一次生成；20/20评分完成；平均加权代码实现分 **63.85%** | DeepSeek 自定义 Judge，非原报告 Judge 配置；不是完整论文训练复现成功率 |
| D2 助手动作轨迹 SFT | 原始7B学生 0/4，最终 LoRA 0/4 | 当前配方无完成率收益，`STOP_NO_GAIN`；不代表所有 SFT 无效 |
| D3 同模型系统对照 | 完整成功原生 / mini 均 0/2；源码产出 0/2 / 2/2 | 系统改变行动行为，但尚未建立科学任务完成优势 |

PaperBench 分数先按各论文 rubric 权重计算，再对20篇等权平均；不是“通过节点总数 / 总节点数”。评分于 **2026-10-09** 完成，保留补评过程中的超时、断开和未知费用记录，不重跑 Agent、不修提交代码、不择高分。

- [完整评测说明与20篇逐篇分数](docs/EVALUATION.md)
- [可机读的20篇结果摘要](docs/evaluation/paperbench-code-dev-all20-summary.json)
- [D2 / D3 方法、代码与失败边界](experiments/README.md)

这些实验沿用冻结的 ResearchAgent v2 完整 CLI 快照，当前最小包的43项 CLI 核心/配置文件与其逐字节哈希一致，没有为了评分修改生产运行时。当前仍不宣称：完整论文复现成功率、超过官方模型、科研策略/Skills 的因果性能增益、SFT泛化提升，或完整上游商业 coding-agent 引擎已经接管运行。**算法训练改善完整 Agent 能力的研究目标尚未达成。**

只发布实验源代码、冻结协议与精简结果，不发布真实凭据、训练/测试数据、模型权重、原始轨迹、完整 Judge 反馈或费用账本。

## 文件结构

```text
src/cli.ts                 实际命令行入口
src/core/                  CLI 需要的模型、工具、策略、上下文和扩展模块
config/                    能力配置
examples/research-task/     最小任务输入与独立检查
scripts/smoke.mjs           不调用真实模型的启动 / 工具调用冒烟检查
docs/ARCHITECTURE.md        实际入口与关键实现映射
docs/EVALUATION.md          当前结果范围、20篇分数和限制
docs/evaluation/           可机读的精简结果
experiments/               冻结的D2/D3研究脚本与协议
evaluation/                既有PaperBench评测源代码
docs/source-manifest.json  复制源码的版本与摘要
.env.example               无真实凭据的配置模板
```

## 来源与贡献边界

ResearchAgent 是此最小发行版的项目名称；CLI 源码从被评测的本地实现按依赖闭包原样复制，内部标识、工具名称和配置前缀仍保留 `COG-CLAW` / `cog_*` / `CLAW_*`。这不是另一个新模型或重写后的新实验系统。

本包不含嵌入式商业引擎镜像、前端、私有凭据或历史任务产物。源码中的风格参考不应被写成“完整官方开源内核”。本次发布未额外授予新的开源许可；npm 依赖遵循各自许可。
