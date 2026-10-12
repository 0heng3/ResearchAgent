# 科研 Agent 算法实验源码

这里保留已有科研能力实验，不新增生产控制器。`src/cli.ts` 是 ResearchAgent 的实际入口；D1–D3 使用冻结的同版本完整 CLI 快照。当前包的 43 项 CLI 核心/配置文件与冻结版本逐字节哈希一致，未将 Python 迁移版本的成绩混入。实验模型与任务范围仍分别报告。

## 已完成的两项诊断

| 实验 | 方法与固定对照 | 真实结果 |
|---|---|---|
| [D2 助手动作轨迹 SFT](d2_trajectory_sft/) | Qwen2.5-Coder-7B-Instruct；相同完整工具循环下 raw / 最终 LoRA；四题每组一次 | 完整成功 0/4 → 0/4，当前配方 STOP_NO_GAIN |
| [D3 系统归因](d3_scaffold_attribution/) | 同一原始 7B；冻结原生系统 / mini-SWE-agent 2.4.6 DefaultAgent；两项新任务 | 完整成功 0/2 / 0/2；源码产出 0/2 / 2/2，不能宣称完成率提升 |

### D2 方法与代码

教师八项任务实际执行并独立重跑正确；按预注册规则接纳七条轨迹，形成 27 条助手动作样本，每 epoch 监督 14,780 个助手 Token。工具观测属于上下文，输入 labels=-100；只监督真实助手动作。LoRA rank=16、alpha=32、dropout=0，更新 q/k/v/o，学习率 2e-5、两 epoch / 54 步，固定最终权重，不按测试选择 checkpoint。

- `d2_trajectory_sft/experiments/build_action_sft_boundary.py`：分别编码精确模板边界的前缀和助手续写，验证无损解码。
- `d2_trajectory_sft/experiments/train_action_lora.py`：固定助手动作 SFT 配方。
- `d2_trajectory_sft/tools/run_gpu_study_cli_fix.py`：有效 CLI 路径下的原始基线、训练与最终权重评估。
- `d2_trajectory_sft/tools/student_model_server.py`：固定模型服务与官方工具调用模板解析。
- `d2_trajectory_sft/protocol.json`：原预注册快照，保留数据阶段的初始状态字段；实际完成情况看 `results-summary.json`，不要修改原协议来伪装后验预注册。

D2 训练 loss 下降只反映教师状态拟合；未观察到功能性源码或科学任务完成收益，不将教师 8/8、样本数或非零 LoRA 参数当作学生能力。

### D3 方法与代码

同一任务、初始输入、原始模型与独立数值检查；每任务/系统一次，最多 16 次物理调用、1200 秒、4096 输出 Token。两题交换运行顺序。工具形式不同，因此比较单位是完整 Agent 系统，不是孤立 Prompt/模块。

- `d3_scaffold_attribution/tools/mini_http_model.py`：连接共同本地模型服务的 HTTP 适配。
- `d3_scaffold_attribution/tools/run_mini_entry.py`：使用官方 DefaultAgent 与原默认配置。
- `d3_scaffold_attribution/tools/run_study.py`：运行冻结对照并汇总。
- `d3_scaffold_attribution/experiments/science.py`：独立科学检查；观测题不得重新包装为新 held-out。

mini 写出了源码，但发生 JSON/CSV 解析、模型对象使用与错误修复失败，也修改了运行输入副本。原始数据不变、失败副本保留、没有人工修复。源码产出增加不代表科学成功增加，不能单独归因于 Prompt 长度。

## 使用与发布边界

本目录是**已有研究源码快照与结果摘要**，不是免配置的一键训练包。脚本按原冻结路径 `/opt/data/private/researchagent`、既有 ResearchAgent v2 快照和服务器环境工作；还需要原数据准备、HF/PEFT/PyTorch 环境、固定模型 revision，以及 D3 的 mini-SWE-agent 2.4.6。未复制第三方源码/依赖，也不自动安装或启动。

训练数据、测试集、教师/学生原始对话、模型权重、缓存、环境、凭据与共享费用账本不入 Git。原始证据仍在 A100x2 原工作区。自托管模型 Token API 费用为 0，不代表 GPU 免费；GPU 时间与供应商费用分开。

D2/D3、B1/C1/D1 和 PaperBench20 已观察任务不用于后续新 held-out 或同题调参。目录中其他早期搜索、SFT/DPO、报告与学习脚本是历史研究资产，不代表它们已经改善完整生产 Agent。不要把离线代码检查、数据完整或文档发布当作能力提升。
