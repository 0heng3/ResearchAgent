# 小型数据分析任务

读取 data.csv。将每组的样本数量、数值之和、均值写入 summary.json；编写可复跑的实际汇总程序并执行。说明代码、输出文件及检查结果。输入文件不得修改。

输出JSON格式：{"groups": [{"group": "A", "count": 2, "sum": 6, "mean": 3}, ...]}，按group排序。最终以本目录 verify.mjs 的独立检查为准。这是本地示例，不是模型能力benchmark。
