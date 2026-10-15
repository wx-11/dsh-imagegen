---
name: dsh-release
description: 在 wx-11/dsh-imagegen 项目中，用户说“更新”“发布更新”“更新版本”时，自动递增版本、验证、提交 commit、推送当前分支、创建并推送版本 Tag，触发现有 npm 发布工作流。同步上游请求使用同步技能。
---

# dsh-imagegen 更新发布

用简体中文执行并汇报。用户已明确授权此流程：在本项目说“更新”即授权修改版本号、提交本次项目修改、推送远程分支、创建并推送版本 Tag；无需重复确认。用户本次明确要求仅修改或禁止发布时，遵从本次限定。

## 确定范围与版本

1. 在当前项目读取实际 AGENTS.md、package.json、工作区 diff、当前分支、远程地址和 `.github/workflows/publish.yml`。确认包名为 `@superdsh/dsh-imagegen`、目标远程为 `wx-11/dsh-imagegen`；路径不固定，按实际工作区定位。
2. 使用当前分支，不新建或切换分支。检查暂存区和未跟踪文件，纳入本次已完成的项目修改；排除密钥、个人数据、临时产物和无关修改。提交前展示简短变更摘要，无需等待确认。
3. 默认将 package.json 当前 SemVer 的 patch 加一；用户指定版本或 minor/major 时按指定处理。保留包身份。通过 `npm version patch --no-git-tag-version --ignore-scripts` 或等效 JSON 编辑更新版本，不让包管理器提前提交或打 Tag。只同步实际存在的同包版本字段，不全局替换历史版本、依赖版本或历史日志。
4. `git fetch origin --tags` 后确认分支未落后或分叉，且目标 `v<version>` 在本地与远程均不存在。遇到远程冲突、已有 Tag、认证失败时停止发布并保留现场；不强推、不覆盖 Tag、不自动 reset/stash 或改写提交。

## 验证与提交

1. 执行 `pnpm typecheck`、`pnpm build`、`node scripts/package-test.mjs`、`node scripts/smoke.mjs` 及 `git diff --check`；执行与本次变更相关的现有回归测试。若脚本不存在，依据实际项目选择对应检查。
2. 所有检查通过后才发布。若 smoke 将当前版本写死，检查其语义：针对当前包版本的断言应从 package.json 获取；模拟远程 Release 的固定版本应保持测试场景有效。修正并重新验证，不跳过或掩盖失败。
3. 核对发布包内容，确保 package.json 版本与拟创建 Tag 完全一致。只用明确的文件路径暂存；不盲目 `git add .`。
4. 创建提交 `git commit -m "chore(release): v<version>"`，记录提交 SHA，检查提交包含版本变更与本次项目修改。

## 推送与 Tag

严格按用户要求顺序执行，命令中的占位符使用本次实际值：

```bash
git push origin HEAD:refs/heads/<current-branch>
git tag -a "v<version>" -m "Release v<version>" HEAD
git push origin "refs/tags/v<version>"
git ls-remote origin "refs/heads/<current-branch>" "refs/tags/v<version>" "refs/tags/v<version>^{}"
```

核验远程分支与附注 Tag 解引用均指向本次提交。分步失败时记录已完成步骤，后续仅重试缺失步骤，不重复升版本或创建提交。推送成功后若可用则通过 `gh run list` / `gh run view` 检查对应提交的 Publish plugin 工作流，等待到成功或失败；失败时分析日志并如实报告，不擅自删除已推送版本 Tag。

Tag 推送会触发现有 GitHub Actions npm 发布，不额外本地运行 npm publish。只有工作流成功或 npm registry 已确认该版本存在时，才声称 npm 发布完成。

## 完成汇报

简短报告新版本、提交 SHA、分支、Tag、远程验证和工作流结果，附工作流链接。工作流仍运行时明确写运行中。仅创建或编辑此 Skill 的请求不触发实际发布。
