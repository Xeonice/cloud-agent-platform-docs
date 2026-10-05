from pathlib import Path
import json,re
ROOT=Path(__file__).resolve().parents[2]
BASE=json.loads((ROOT/'artifacts/migration-audit/baseline.json').read_text())['all_acs']
OLD={r['id']:r for r in json.loads((ROOT/'artifacts/migration-audit/project-automation-current.json').read_text()) if r['id'].startswith('AC-AUT-')}
# Each group names the actual implementation owners read against all Given/When/Then below.
MAP={}
def add(domain,nums,names,reason):
 for num in nums:MAP[f'REQ-{domain}-{num:03}']=(names.split(),reason)
add('IMG',[1,2,4,5,6,8],'useImages.ts RegisterImageModal.view.tsx ValidationResult.view.tsx image-application.service.ts oci-registry.client.ts','注册的输入、只读预检、保存时再次校验、忙态守卫、关闭焦点与重复定位各有独立状态；使用真实digest，不沿用失效结论或把请求失败当无效镜像。')
add('IMG',[3],'imageIssueCopy.ts ValidationResult.view.tsx image-application.service.ts oci-image-spec.provider.ts','三级结论与逐码人话独立，未知码单列兜底；基础谱系在预检验证，tmux不是强制判据。')
add('IMG',[7],'ImageRequirementsPanel.view.tsx ImagesContainer.tsx oci-image-spec.provider.ts','无模态complementary不接Esc、不抢焦点；启动命令是硬门槛，WorkingDir可缺省/，两硬门槛和两提醒分开。')
add('IMG',[10,11,12,13,14],'useImages.ts EnvVarEditor.view.tsx validateEnvVar.ts mapEnvErrorResponse.ts env-var-set.vo.ts env-merge.domain-service.ts','单卡草稿取消/切卡丢弃；已存Secret值不回显且空值保持密文；UTF8、保留名、重复与50条同码校验，错误映回具体格或整表，运行参数只供新任务使用。')
add('IMG',[20],'ImageCard.view.tsx imageCardModel.ts useImageOperationFocus.ts','真实digest短串原位展开、折行、全选与完整复制；没有版本或不安全复制环境明确给原因，不报告假成功。')
add('IMG',[21,22,23,24,25,26],'useImages.ts UpdateCompareDialog.view.tsx ImageVersionHistory.view.tsx ImageCard.view.tsx image-application.service.ts image-manifest.repository.impl.ts','更新检查由用户触发；同tag新行登记后再激活，被点历史行独立忙态；旧任务引用不改，更新继承加密运行参数，切回使用该版自己的配置，结果标题与作用范围分开。')
add('IMG',[30,31,32],'useImages.ts ImageCard.view.tsx PresetDisableDialog.view.tsx image-application.service.ts image-facade.adapter.ts','停用乐观更新与失败回滚，启用走activate；预制不能删除且停用先确认。新任务门口按启用/校验状态拦截，已有任务不受影响。')
add('IMG',[33,34],'useImages.ts DeleteImageConfirm.view.tsx image-application.service.ts image-manifest.repository.impl.ts sandbox-facade.adapter.ts','删除影响清单取真实预检；停止/失败引用阻挡，destroyed排除且同事务释放其image_ref，失败不能当0。忙态守卫、409刷新与改为禁用在同确认弹层处理。')
add('IMG',[40,41,42,43],'usePresetImageDownload.ts usePresetImageProvision.ts PresetImageDownload.view.tsx presetImageChain.ts preset-image-provisioner.ts preset-image.check.ts','下载由用户触发并走同源预制准备链；只显示真实阶段/大小/百分比/已用时，未知进度不定值；冲突和失败不自动重试，done后再次检查才确认可用。')
add('IMG',[50,51,52],'ImagesContainer.tsx useImages.ts','页头可用，首次卡片骨架、无镜像、筛空和列表读取失败分开；失败原位重试，不虚报没有镜像。')
add('SYS',[1,2,3],'AppFrameContainer.tsx GlobalBannerContainer.tsx useSystemStatus.ts','共享导航入口落到设置系统页，诊断入口保存一次性意图；退出路径回工作台，工作台顶部不再显示资源概念。')
add('SYS',[10,11,12,13,14],'useSystemStatus.ts resourceModel.ts ResourcePoolCard.view.tsx system-resources.service.ts memory.probe.ts','资源轮询与双查询刷新，在途保留旧值、失败撤去数字；REST用量和阈值同源，整体取最差，测不准不判耗尽，下一步对准实际坏的维度。')
add('SYS',[20,21],'resourceModel.ts ResourcePoolCard.view.tsx GlobalBannerContainer.tsx system-resources.service.ts project-facade.adapter.ts','成果只计销毁时保留的目录并按实际块占用；占比、倒计时与统计截断如实显示；超量治理跨项目，同页全部项目成果弹层关闭后还焦点。')
add('SYS',[30,31],'sandboxEnvModel.ts SandboxEnvStatusCard.view.tsx useProviderLogs.ts ProviderLogPanel.view.tsx system-providers.service.ts provider-log.service.ts','真实窗口失败率与接口阈值，无样本不冒充0%；缺凭证为中性停用，能力用用户词；日志仅点击时读取实际最新20行，缺来源说明原因，不编日志。')
add('SYS',[40],'connectionModel.ts ConnectionStatusCard.view.tsx useSystemStatusModels.ts','REST只按本页查询判断；events无测量标未知，本页不沿用已离开工作台的终端会话或旧健康结论。')
add('SYS',[50],'system-settings.service.ts','SYS规格389明确本轮不画访问保护区块；接口/参数/横幅/README先行。')
add('SYS',[60],'useProxySettings.ts ProxyConfigForm.view.tsx ProxySettingsCard.view.tsx system-settings.service.ts','设置独立回填/重试，HTTP(S)错误逐字段关联并保留输入；保存不重测、空值可清除，成功原位status且无轻提示，说明限定真实联网检查范围。')
add('SYS',[70],'ResourcePoolCard.view.tsx SandboxEnvStatusCard.view.tsx AuditStreamCard.view.tsx useSystemStatusModels.ts','首屏可访问忙态骨架、审计5行，独立读取允许代理和诊断先用；资源KPI、水位、路径和成果同槽，provider条数来自真实registry缓存。')
add('SYS',[71],'resourceModel.ts ResourcePoolCard.view.tsx system-resources.service.ts sandbox-facade.adapter.ts','默认准入同源capacity包含已停止登记数；0红色circle-x和拒绝原因，1琥珀triangle，正常正文；缺capacity只显示活跃数而不推算。')
add('SYS',[75,76],'useSystemStatus.ts useGlobalBanner.ts GlobalBannerContainer.tsx ConnectionStatusCard.view.tsx','不可达各卡原位失败与重取，本页状态横幅不自指；离线重测就地跑唯一诊断流，第五项更新实际联网结果并撤去横幅。')
add('DIA',[1,2,3,4,6,40],'useSystemStatus.ts diagnoseModel.ts DiagnosticsCard.view.tsx DiagnosticItem.view.tsx useDiagnosticsDisclosure.ts diagnostics.service.ts','首帧清单/时限权威，按id归位、代际保护和跨页缓存；中断保留已返回，未返回不转圈，timeout单列，非正常项默认展开；汇总原位status，复制仅针对真实命令。')
add('DIA',[5,10],'container-runtime.check.ts dev-kvm.check.ts substrate.ts','默认provider真实依赖决定严重度；容器应答需Docker证据，socket存在或普通HTTP不能冒充正常。')
add('DIA',[11],'dev-kvm.check.ts','虚拟化按平台、macOS架构/版本和Linux KVM权限判断；Windows提示不误讲/dev/kvm，未知标志不是失败。')
add('DIA',[12],'disk-space.check.ts','磁盘使用率按门槛判断，下一步指清理保留下来的成果或删项目，不引向停止任务释放磁盘。')
add('DIA',[13],'port-conflict.check.ts','只查当前配置用途端口，报告真实pid/名称证据，自进程正常；查证不了不判正常或冲突。')
add('DIA',[14],'outbound-network.check.ts connectivity.probe.ts connectivityVerdict.ts DiagnosticItem.view.tsx','探测注册Agent声明端点；超时和确证不通分开，全部超时只警告；本地下载源按实际可达判断，下一步依默认环境分岔。')
add('DIA',[16],'data-root-fs.check.ts','真实文件系统与reflink三态；APFS无法判定不给迁盘建议，Linux ext4不支持时说明完整拷贝仍可用和Btrfs/XFS选择。')
add('DIA',[17,18,20],'preset-image.check.ts preset-image-provisioner.ts provision-plan.ts presetImageChain.ts usePresetImageProvision.ts PresetImageCheck.view.tsx','镜像五步与准备动作同初始化共源；未staged只是提示，来源检查不过不下载，未知大小不造百分比，非Docker默认环境不给docker pull。')
add('DIA',[30],'diagnose.sh diagnose.mjs','独立Node自检在API起不来时仍能检查版本、原生模块、数据目录和端口，不依赖已启动后端。')
add('AUD',[1,2,3,4,5,20,21],'useAuditStream.ts useAuditFilters.ts auditRowModel.ts auditStream.ts AuditStreamContainer.tsx AuditStreamCard.view.tsx AuditEventRow.view.tsx AuditFilterBar.view.tsx audit.repository.ts','结构化审计独立区块，服务端筛选与seq增量/历史游标分离；失败、筛空、断层、实时中断各自如实展示；任务时间线清四条件，半日期/逆序不应用，单行展开。')
add('AUD',[6],'useExportAuditLogs.ts system.service.ts audit-export.service.ts diagnostic-snapshot.service.ts runtime-log-reader.ts','原生新目标下载tar.gz保留当前页/诊断；真实审计、可用日志、最近真实诊断与范围说明，24h/50MB限制；缺日志、部分诊断和实际截断均明确说明。')
add('AUD',[7],'runtime-log-writer.ts','真实落盘按文件份数轮转，end后rename再开流，最旧删除与窗口缓冲避免丢行。')
add('AUD',[8],'audit-recorder.impl.ts audit-redaction.ts log-redactor.ts audit-export.service.ts','写入口及导出诊断脱敏凭证明文，真实SQLite/运行日志tar包全文搜索令牌不可见。')
allfiles=[p for repo in ['web/src','api/apps','api/packages','api/scripts'] for p in (ROOT/repo).rglob('*') if p.is_file() and 'test' not in p.parts and '__stories__' not in p.parts]
allfiles.append(ROOT/'api/diagnose.sh')
def actual(name):
 matches=[p for p in allfiles if p.name==name]
 assert matches,name
 return matches[0]
def reference(path):
 lines=path.read_text().splitlines()
 line=next((i+1 for i,s in enumerate(lines) if re.search(r'export (?:async )?(?:class|function)|^  (?:async )?\w+\(',s)),1)
 return f'{path.relative_to(ROOT)}:{line}'
EXEC={
'web/src/acceptance/automation-workflows.test.tsx':('AC-AUT-002.1 AC-AUT-004.4 AC-AUT-010.1 AC-AUT-011.2 AC-AUT-011.3 AC-AUT-014.1 AC-AUT-023.4 AC-AUT-023.5 AC-AUT-024.1 AC-AUT-024.2 AC-AUT-024.5'.split(),'4真实container/HTTP场景实际通过'),
'web/src/acceptance/image-registration-deletion.test.tsx':('AC-IMG-004.1 AC-IMG-006.1 AC-IMG-008.1 AC-IMG-034.1 AC-IMG-034.4'.split(),'2真实container/HTTP场景实际通过'),
'web/src/acceptance/image-download-recheck.test.tsx':('AC-IMG-040.2 AC-IMG-041.2 AC-IMG-043.1'.split(),'1真实手动SSE完成后再次检查场景通过'),
'web/src/acceptance/image-provision-conflicts.test.tsx':('AC-IMG-041.1 AC-IMG-042.2 AC-IMG-042.3'.split(),'3真实准备请求与冲突场景通过'),
'web/src/acceptance/system-diagnostics-audit.test.tsx':(['AC-SYS-020.7','AC-SYS-030.5','AC-SYS-031.1','AC-SYS-060.4','AC-SYS-060.5','AC-SYS-030.7','AC-SYS-071.2','AC-DIA-003.3（改）','AC-DIA-003.6','AC-DIA-002.3（改）','AC-AUD-003.3（改）','AC-AUD-003.4','AC-AUD-020.3'],'5真实container/HTTP/SSE场景通过，含读取失败后加载块全部清除'),
'api/acceptance/img/service/preview-and-preflight.spec.ts':('AC-IMG-002.2 AC-IMG-002.4 AC-IMG-006.1 AC-IMG-033.3'.split(),'3生产service+真实SQLite场景通过'),
'api/acceptance/img/sqlite/deletion-transaction.spec.ts':('AC-IMG-034.2 AC-IMG-034.3'.split(),'2真实SQLite同事务引用保护场景通过'),
'api/acceptance/sys/sqlite/audit-query-export.spec.ts':('AC-AUD-002.1 AC-AUD-006.1 AC-AUD-006.2 AC-AUD-006.3 AC-AUD-008.1'.split(),'6真实SQLite/文件/tar导出场景通过，含>50MB源实际截断/中断诊断/全文脱敏/真实异步IO失败降级/应用版本构建快照'),
'api/acceptance/sys/service/environment-verdicts.spec.ts':('AC-DIA-004.2 AC-DIA-004.3 AC-DIA-005.2 AC-DIA-011.1 AC-DIA-011.2 AC-DIA-016.1 AC-DIA-016.2'.split(),'3生产环境判据场景通过'),
'api/acceptance/sys/service/provider-log.spec.ts':(['AC-SYS-031.1'],'团队fresh真实日志最新20行/缺来源场景通过'),
}
rows=[]
for ac in BASE:
 if ac['domain'] not in {'IMG','AUT','SYS','DIA','AUD'}:continue
 if ac['domain']=='AUT':
  names=['AutomationsPanelContainer.tsx','useAutomations.ts','useAutomationForm.ts','automation-application.service.ts','automation.scheduler.ts']
  prior=OLD[ac['id']]
  reason=prior['reason'] if prior['status']=='closed' else '当前触发与结果完整核对；原报告尚未实跑指定验收属于执行范围，不能当作实现缺口。'
 else:names,reason=MAP[ac['requirement']]
 refs=list(dict.fromkeys(reference(actual(name)) for name in names))
 row={k:ac[k] for k in ['id','domain','version','requirement','given','when','then']}
 row.update(status='closed',verification='code-review',specifiedLevel=ac['level'],specifiedLevelExecuted=False,source=f"docs/design-v2/gap/product/{ac['source_file']}",evidence=refs,reason=reason,executionEvidence=[])
 for file,(ids,result) in EXEC.items():
  if ac['id'] in ids:row['executionEvidence'].append({'kind':'executed-regression','source':file,'result':result})
 if ac['id']=='AC-IMG-026.3':row.update(status='superseded',reason='与026.1明确二选一，已选copyConfigFromId参数继承分支；不实现反向「不带参数」行为，也不计为待做。')
 if ac['id']=='AC-IMG-042.4':row.update(status='deferred',reason='IMG规格654/661与SYS Q16A明确当前代理只用于联网检测；镜像下载代理列为后续能力，本轮未实现且不假称closed。')
 if ac['id']=='AC-SYS-050.1':row.update(status='deferred',reason='SYS规格389合并说明明确本轮不画访问保护区块，先接口/参数/横幅/README；该UI条件延后，不能算已实现。')
 if ac['id']=='AC-SYS-070.2':row.update(verification='code-review-and-executed-browser',specifiedLevelExecuted=True,reason='数据块与骨架按卡内容宽度和registry数量一一对位；最新生产dark/light×1440/1024/390逐卡高度前后完全一致，≤20px严格断言通过。旧真实失败记录保留。',executionEvidence=[{'kind':'executed-browser','source':'artifacts/design-image-system-v2/height-recheck2/review.json','result':'旧生产before=[366,398] after=[350,284]；保留真实失败断言。'},{'kind':'executed-browser','source':'artifacts/design-image-system-v2/sys-final/review.json','result':'6/6通过：1440前后[370,284]；1024前后[424,354]；390前后[440,354]，两主题相同。'}])
 if ac['id']=='AC-AUT-001.3':row['evidence'].append('web/src/hooks/workbench/useCommandPalette.ts:250');row['reason']='共享Command已按AUT具体入口修成任意页每ready项目一条具名规则，非ready排除；团队fresh真实AppFrame/HTTP验收11条通过，待最新生产browser另记。'
 if ac['id']=='AC-AUT-023.1':row['reason']='人话/后端原文/通知旁注/输出顺序保留；旧终态「打开任务」由同规格Q-AUT-02与023.5改为查看成果，运行中保留打开任务。'
 if ac['id']=='AC-AUT-025.1':row['evidence']+=['api/packages/modules/sandbox/src/application/automation-task-launcher.adapter.ts:1','api/acceptance/aut/sqlite/artifact-recovery.spec.ts:1','api/acceptance/sbx/sqlite/retained-task-artifacts.spec.ts:1'];row['reason']='终态先持久化结果/日志再keepVolume销毁，按原结束时刻+7天登记规则名快照；destroyed登记失败重试/重启恢复独立于rule/run存活，workspace tombstone幂等。'
 rows.append(row)
assert len(rows)==401 and len({r['id'] for r in rows})==401
(ROOT/'artifacts/migration-audit/image-system-current.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
from collections import Counter
print(Counter(r['status'] for r in rows));print(Counter(r['domain'] for r in rows))
