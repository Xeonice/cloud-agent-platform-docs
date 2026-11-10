# 历史结算 schema 与 factory fixture

这些文件是 API commit `17e2ad52bfacea49ec9834d4f98693e3e66fbd79` 的逐字原文，逐文件摘要见 `provenance.json`。测试执行原 SQL migrations、原 `UpgradeStore` 和 `UpgradeContractStore`，只通过原 `bootstrap / accept / claim / commit / save` 工厂建立意图与结果，不直接写 accepted rows。

测试的 Nest 注入 token、实例 ID、时间与物理角色观察是明确本地端口。TypeScript 只在测试加载时转译；原 schema/contracts/trust/factory 文件不改写。该目录位于 `deploy/testing`，不会进入 installer 包；测试通过不构成实际旧实例 binary、Supervisor drain 或线上接入资格。
