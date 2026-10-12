# 科研任务能力与评测范围

核对日期：2026-10-12。PaperBench 全量评分完成于 2026-10-09；D2/D3 完成于 2026-10-12。本文件区分源码实现、运行验收与科学任务结果，不以打包、格式、日志或测试通过代替科研能力。

## 实际科研 Agent

实际入口为 `src/cli.ts` → `runStreamingToolLoop()` → 模型工具调用 → `executeRuntimeTool()` → 运行结果回填。任务意图识别与科研能力目录参与上下文组织，但尚未通过同模型控制变量实验证明科研策略/Skills的独立因果收益。

现有发行版的43项 CLI 核心/配置文件与 D1–D3 冻结原生快照逐字节哈希一致；原生快照还含不在最小CLI依赖闭包内的文件，因此不宣称整个发行包与原始项目文件完全相同。离线 `npm test` 使用假模型，不算真实模型任务成功率。

## PaperBench Code-Dev：20/20，平均63.85%

- 固定官方 `all.txt` 的全部20篇，不混入 dev、不挑题。每篇一次 Agent 生成，生成集合与提交保持不变。
- Agent / 自定义 Judge 使用 DeepSeek；Code-Dev使用官方 SimpleJudge 的 rubric 权重。**Judge不是原报告的 o3-mini-high 配置。**
- 每篇先计算 rubric 加权分，再对20篇等权平均；从保留的最终记录重新计算均分为 **63.84588781155853%**。
- Agent原预算为每篇30分钟、最多48次物理调用。独立评分阶段曾提高时间预算并补齐超时/断开任务的剩余判定，未重跑Agent、未修改提交、不从多次生成中择高分，保留已有评分和未知费用记录。
- 最终20篇评分均已完成，没有删除困难文章后只计算成功评分子集。接口失败与Agent失败分开保存。
- 代码开发分数**不是**完整训练/推理复现成功率，不等于真实实验指标通过率，也不能把与官方报告的数值差写成系统胜出。

[可机读的全量摘要](evaluation/paperbench-code-dev-all20-summary.json)仅含顺序、分数、状态和必要范围信息，没有论文专用Prompt、rubric叶节点或Judge反馈。评测源代码保存在 [`evaluation/paperbench_code_dev/`](../evaluation/paperbench_code_dev/)，其原冻结路径和外部账本依赖没有重写为新的可直接运行环境。

| 原顺序 | 论文ID | 加权代码实现分 | 生成状态 | 评分状态 |
|---|---|---:|---|---|
| 1 | `fre` | 60.47% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 2 | `mechanistic-understanding` | 90.93% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 3 | `bridging-data-gaps` | 49.29% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 4 | `test-time-model-adaptation` | 59.79% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 5 | `all-in-one` | 61.78% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 6 | `sequential-neural-score-estimation` | 91.71% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 7 | `robust-clip` | 40.38% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 8 | `what-will-my-model-forget` | 85.12% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 9 | `pinn` | 75.20% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 10 | `stay-on-topic-with-classifier-free-guidance` | 61.93% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 11 | `rice` | 17.31% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 12 | `sample-specific-masks` | 86.76% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 13 | `adaptive-pruning` | 46.42% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 14 | `sapg` | 60.79% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 15 | `lca-on-the-line` | 47.63% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 16 | `stochastic-interpolants` | 82.70% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 17 | `bbox` | 44.85% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 18 | `lbcs` | 88.20% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 19 | `bam` | 79.66% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |
| 20 | `ftrl` | 45.98% | VALID_FINISHED | COMPLETE_CUSTOM_JUDGE |

## D1：真实科学程序，不作训练收益

既有完整Agent生成两项科学程序，参数选择、测试指标与独立数值重跑正确。原始整包验收为1/2，另一项涉及任务未声明的报告根目录约束；原始记录保留，不改成原协议2/2。该证据说明有实际科研执行案例，不证明策略因果优势或新训练收益。

## D2：助手动作轨迹SFT，无完成率增益

- 固定 Qwen2.5-Coder-7B-Instruct revision；相同完整CLI、工具和评估配置下，raw / 最终LoRA各四题、每题一次。
- 七条接纳教师轨迹产生27条助手动作样本，每epoch监督14,780助手Token；输入与工具观测不参与助手损失。教师数据不是学生结果。
- LoRA rank16 / alpha32 / q,k,v,o，学习率2e-5，两epoch、54步，使用固定最终权重，不按测试调参或挑checkpoint。
- 原始 **0/4**、SFT **0/4**，两组各4/4有效；均无功能性源码或科学实验产物。训练loss下降不代表任务收益。当前配方 **STOP_NO_GAIN**。

[代码、原协议](../experiments/d2_trajectory_sft/)与[精简结果](../experiments/d2_trajectory_sft/results-summary.json)。

## D3：同模型系统归因，行动增加但科学成功未增加

- 固定原始7B，原生完整系统对比 mini-SWE-agent2.4.6官方DefaultAgent；两项新任务交换运行顺序，每系统/任务一次。
- 每项最多16次物理调用、1200秒、4096输出Token。共同模型服务、相同任务输入及独立科学检查；工具形式不同，比较单位是完整系统。
- 完整成功均 **0/2**；源码产出原生 **0/2**、mini **2/2**。原生共2次调用 / 28,077Token / 114.79秒；mini共32次 / 176,255Token / 205.44秒。
- mini发生JSON/CSV解析、模型对象使用和错误修复失败，修改了运行输入副本。原始输入不变，失败副本保留，没有人工修复或择高分。
- 不能将源码产出提升说成完整完成率提升，也不能把差异单独归因于Prompt长度，或推广为生产模型退步。

[代码、原协议](../experiments/d3_scaffold_attribution/)与[精简结果](../experiments/d3_scaffold_attribution/results-summary.json)。自托管Token API费用为0，不代表GPU免费；GPU时间和供应商费用分开。

## 发布与继续研究的边界

这些新增文件是已有研究源码与精简结果，不是免配置训练包。复现需要原数据准备、固定模型、服务器依赖、原生快照和原外层账本；本次没有启动新训练或模型评测。训练/测试数据、模型权重、原始模型/工具轨迹、Judge反馈、缓存、凭据及账本不入Git。

D2/D3、B1/C1/D1和PaperBench20均为已观察任务，不用于后续新held-out或同题调参。后续方法选择必须由新的能力假设与固定基线支撑，不盲目叠加SFT/DPO/RL或Guard。当前尚未达成“算法训练真实改善完整Agent能力”的研究目标。
