---
name: dsh-sync-upstream
description: 更新 dsh-imagegen 分叉项目，从 dickpy/dsh-imagegen 合并上游新增修改，保留 superdsh 包身份、本地功能和独立版本号。用户要求同步上游或合并原仓库更新时使用。
---

# 更新 dsh-imagegen 上游

上游：`https://github.com/dickpy/dsh-imagegen.git`。
目标：将上游新增功能与修复合并到当前分叉，保留本项目已有修改，以本项目版本序列发布。
只编写、安装或修改这个技能时，不执行上游合并。

## 确定起点

在用户指定仓库中读取适用的 AGENTS.md，检查工作区、当前分支、远程和近期提交。以下命令仅用于检查：

```bash
git status --short
git branch --show-current
git remote -v
git log -8 --oneline
node -p "JSON.stringify({name:require('./package.json').name,version:require('./package.json').version,repository:require('./package.json').repository})"
```

读取 package.json、src/protocol.ts、src/updater.ts、tsdown.config.ts、cordis.patch.yml、.github/workflows/publish.yml 和现有测试。
以运行时读取的本地值为准，不把本地版本写死在技能里。

若工作区有用户改动，保留它们。不要自动 stash、清理或覆盖；在独立临时目录生成可审阅的合并结果，或询问如何处理阻碍合并的改动。不要自行创建分支。

## 获取与合并

1. 用 `git ls-remote --symref https://github.com/dickpy/dsh-imagegen.git HEAD` 检查上游默认分支，不假定 main/master。
2. 把该分支获取到独立的远程跟踪引用，例如 `refs/remotes/dsh-upstream/<分支名>`。可直接从 URL fetch，不修改 origin 或其推送地址。记录本地起点 SHA、上游 SHA 和 merge-base。
3. 比较共同祖先至上游的提交与 diff，识别新增功能、修复、依赖变更和删除。已合并、无差异时结束，不增加版本。
4. 在实际执行前检查用户对 Git 与批量修改的授权；遵守仓库确认规则。获得所需授权后，以 `git merge --no-commit --no-ff <上游引用>` 合并，保持待审阅状态；不自动 commit、push、打 tag 或发布。
5. 逐项解决冲突。不要全局使用 ours/theirs，也不要整文件回退以掩盖上游改动。将上游改进和本地功能组合；仅对身份、版本与发布目标字段采用本地值。
6. 无共同祖先时，不执行 `--allow-unrelated-histories`。通过文件差异移植所需变更，说明缺少共同历史；另行授权后才采用不同的 Git 历史策略。

合并中断时检查 MERGE_HEAD、冲突路径和现有进度，从当前状态继续，不重复开始合并。合并前保留原始文件与 diff 等恢复资料到被 Git 忽略的 artifacts/。需要撤销时先确认当前状态；不要用 reset --hard、clean 或覆盖命令丢弃用户改动。

## 保留本项目差异

以下是本分叉当前必须保留的行为；运行时核实最新源码与用户新增要求：

- npm 包名为 `@superdsh/dsh-imagegen`。客户端 ModuleLoader ID、Cordis patch、更新器、安装说明、测试与发布校验保持一致。
- GitHub 仓库、反馈入口和更新器 Release 地址采用本地配置；上游 URL 只作为代码来源，不成为安装或更新目标。
- npm 认证只引用 GitHub Secret `NPM_TOKEN`。公开文件不写个人 npm 账号、Token 或其他密钥；验证认证时不打印账号或密钥。
- 各界面返回按钮保留；快捷数量为 1、2、5、10、50、100，自定义与后端统一限制 1–100，多张结果适配显示。
- GPT/通用图片接口使用 `n` 批量请求；chatgpt2api `/v1/videos` 使用 JSON 提交、任务 ID 轮询、`aspect_ratio` 原样传递、最多 8 张参考图，按实际返回结果显示。
- “自动”比例不发送参数。清晰度和细节控件不恢复，上游请求不发送 quality/detail/resolution/image_size；历史旧字段的兼容读取不等于恢复参数发送。
- 其他模型保持各自协议与必要参数，不把上述移除规则套到 Seedream 等模型必需的原生参数上。
- 保留 `.github/workflows/publish.yml` 的自有包发布、标签与包版本一致校验、Secret 认证，以及 `.gitignore` 的 `artifacts/` 忽略项。

当上游改进涉及这些区域时，适配实现而不是跳过更新。新的明确用户要求优先于这份当前差异清单。

## 独立版本号

合并前记录本地 package.json.version。上游版本号不覆盖本地版本，不因上游版本更大而跳号。

- 用户指定版本时使用该版本；用户要求只同步不升级时保持原版本。
- 本次确实引入新改动、用户未指定版本时，默认基于合并前本地稳定 SemVer 递增 patch。例如本地 `1.6.9` 更新为 `1.6.10`，即使上游已到 `2.0.0`。
- 本地为预发布或不规则版本时保留原值，说明并确认版本策略，不猜测递增方式。
- 同步 package.json.version 与 src/protocol.ts 的 PLUGIN_VERSION；检查其他当前版本常量、发布说明及锁文件中的根包字段。不要替换历史发布版本或依赖版本。
- 不为了同步上游创建版本标签。最终给出建议标签 `v<本地新版本>`，实际发布另按用户授权执行。

## 验证与交付

依赖发生变化时使用仓库的 pnpm 版本更新锁文件，随后验证 frozen-lockfile 安装。不要用上游锁文件覆盖本地独有依赖；没有依赖变更时不重新安装。

在仓库支持这些命令时运行：

```bash
pnpm typecheck
pnpm build
node "scripts/smoke.mjs"
node "scripts/image-options-test.mjs"
node "scripts/chatgpt2api-test.mjs"
git diff --check
git diff --name-only --diff-filter=U
```

补充验证上游新增行为和冲突解决影响的路径。验证本地包身份、版本常量一致、无未解决冲突；检查 staged 与 unstaged diff，避免遗漏 merge 暂存区中的变更。

记录哪些命令已运行、结果和仍待解决的问题。只在检查通过后报告合并完成；待提交的 merge 仍需明确交代，不将它描述为已提交或已发布。实际发布只使用自有包名与版本。

最终用简体中文说明：上游来源与 SHA、本地起点、合入的主要变化、保留的本地差异、本地版本前后值、验证结果及 Git 状态。给出可审阅的同步记录文件，避免把上游版本号当作本地发布号。

## 调用示例

```text
使用 $dsh-sync-upstream，把 dickpy/dsh-imagegen 的最新改动合并到当前仓库，保留我们的包名、发布配置与图片接口适配。以当前本地版本递增补丁版本，运行检查，保留结果供我审阅。
```
