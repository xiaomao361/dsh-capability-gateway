window.__ModuleLoader__.load({
  id: 'dsh-capability-gateway',
  factory(require) {
    const React = require('react')
    const { z } = require('zod')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React
    const labels = {
      managed: '网关管理', native: '原生保留', native_override: '同名能力由原生提供', not_in_scope: '本会话未纳入', unknown: '待确认',
      disabled: '配置已停用', plugin_failed: '插件启动失败', tools_registered: '已发现工具', no_tools_observed: '未观察到工具', gateway: '原生目录已精简', 'gateway-sdk': 'PTC SDK 声明已精简', 'native-sdk': 'PTC SDK 原生暴露',
      search: '搜索', load: '加载 Skill', describe: '查看工具', call: '调用 MCP', invalid: '无效操作',
      success: '成功', error: '失败', cancelled: '已取消', correct: '正确', wrong: '需修正', unreviewed: '未评估',
    }
    const label = value => labels[value] ?? value ?? '—'
    const percent = value => value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
    const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    const shortSession = value => { const id = value.replace(/^session-/, ''); return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id }
    // Browser-only: the report is already generated on the Host; this just hands
    // the text to the user's download folder. Tests run without a DOM.
    const saveFile = (filename, content, type) => {
      if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
      const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }))
      const link = document.createElement('a')
      link.href = url; link.download = filename; link.rel = 'noopener'
      document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      return true
    }
    const style = `
.cg-view-heading{margin:0 0 16px}.cg-view-heading p{color:var(--cg-muted);margin-top:4px}.cg-feature{margin:18px 0}.cg-feature-body{padding:14px}.cg-feature-body>p+p{margin-top:8px}.cg-editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 0}.cg-choices{min-width:0;border:1px solid var(--cg-border);border-radius:8px;padding:12px}.cg-choices legend{font-weight:600}.cg-field{display:flex;flex-direction:column;gap:5px}.cg-field input{width:100%}.cg-choices ul{list-style:none;padding:0}.cg-choices li label{display:flex;align-items:flex-start;gap:8px;padding:6px 0;cursor:pointer}.cg-page input[type=checkbox]{min-height:20px;width:20px;flex-shrink:0;margin:0}.cg-choices code{overflow-wrap:anywhere}.cg-diagnostics li button{margin-inline-start:8px}.cg-probe-results li{padding:10px 0}.cg-probe-results li+li{border-top:1px solid var(--cg-border)}.cg-probe-results strong{overflow-wrap:anywhere;margin-inline-end:8px}.cg-feature summary{font-weight:600}.cg-feature .cg-notice{overflow-wrap:anywhere}
@container(max-width:620px){.cg-editor-grid{grid-template-columns:1fr}}
.cg-export{align-items:center}.cg-export p{margin:0}
.cg-page{container-type:inline-size;max-width:1080px;min-width:0;width:100%;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;--cg-muted:var(--dsw-alias-label-tertiary);--cg-surface:var(--dsw-alias-bg-module-platform);--cg-border:var(--dsw-alias-border-l3);--cg-accent:var(--dsw-alias-state-business-primary,#4263eb);--cg-tint:color-mix(in srgb,var(--cg-accent) 7%,var(--dsw-alias-bg-layer-1));--cg-error:var(--dsw-alias-state-error-primary,#c23948)}
.cg-page *{box-sizing:border-box}.cg-page h2{font-size:20px;letter-spacing:-.4px;line-height:1.3;margin:0;font-weight:650}.cg-page h3{font-size:14px;margin:0;font-weight:600}.cg-page p{margin:0}.cg-page .cg-muted{color:var(--cg-muted)}.cg-icon{width:18px;height:18px;flex-shrink:0;vertical-align:middle}.cg-brand{display:flex;gap:10px;align-items:center}.cg-brand>.cg-icon{color:var(--cg-accent);width:26px;height:26px}
.cg-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.cg-header p{margin-top:5px;color:var(--cg-muted);font-size:12px}.cg-header button{display:flex;gap:6px;align-items:center}.cg-toolbar{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:14px 0}.cg-toolbar label{display:flex;flex-direction:column;gap:5px;min-width:0;color:var(--cg-muted);font-size:12px}.cg-toolbar label>*{color:var(--dsw-alias-label-primary);font-size:13px}.cg-grow{flex:1;min-width:170px}.cg-scope{margin:0 0 14px;align-items:center}.cg-scope label{flex-direction:row;align-items:center;gap:10px}.cg-scope select{max-width:100%}.cg-scope-meta{margin-inline-start:auto}
.cg-page button,.cg-page select,.cg-page input{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--cg-border);border-radius:6px;min-height:34px;padding:6px 10px;max-width:100%}.cg-page button{cursor:pointer;white-space:nowrap}.cg-page button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.cg-page button:disabled,.cg-page select:disabled{cursor:default;opacity:.5}.cg-page :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--cg-accent));outline-offset:2px}
.cg-nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;width:100%;padding:4px;background:var(--cg-surface);border:1px solid var(--cg-border);border-radius:10px;margin:0 0 18px}.cg-nav button{white-space:normal;background:transparent;border-color:transparent;min-height:36px}.cg-nav button[aria-pressed=true]{background:var(--cg-tint);color:var(--dsw-alias-label-primary);border-color:var(--cg-accent);font-weight:600;box-shadow:inset 0 -2px 0 var(--cg-accent)}.cg-nav button[aria-pressed=true]:hover{background:var(--cg-tint)}
.cg-page .cg-notice{padding:10px 12px;background:var(--cg-surface);border:1px solid var(--cg-border);border-inline-start:3px solid var(--cg-accent);border-radius:6px;margin:12px 0;font-size:12px;overflow-wrap:anywhere}.cg-page .cg-error{color:var(--cg-error)}.cg-page .cg-notice.cg-error{border-inline-start-color:var(--cg-error)}
.cg-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--cg-border);border-radius:10px;background:var(--cg-tint);margin:0 0 18px;padding:14px 0}.cg-overview dl{margin:0;padding:0 16px;min-width:0}.cg-overview dl+dl{border-inline-start:1px solid var(--cg-border)}.cg-overview dt{display:flex;gap:7px;align-items:center;font-size:12px;color:var(--cg-muted)}.cg-overview dt .cg-icon{color:var(--cg-accent)}.cg-overview dd{font-size:25px;font-weight:650;font-variant-numeric:tabular-nums;margin:6px 0 0;line-height:1.25}.cg-overview small{font-size:11px;color:var(--cg-muted)}
.cg-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 12px}.cg-stats dl{margin:0;min-width:0;padding:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--cg-border);border-radius:9px;position:relative}.cg-stats dl.cg-primary{grid-column:span 2;background:var(--cg-tint);border-top:2px solid var(--cg-accent)}.cg-stats dt{font-size:12px;color:var(--cg-muted)}.cg-stats dd{margin:8px 0 0;font-size:23px;letter-spacing:-.5px;line-height:1.25;font-variant-numeric:tabular-nums;font-weight:650}.cg-stats .cg-primary dd{font-size:32px}.cg-stats small{display:block;margin-top:6px;font-size:11px;color:var(--cg-muted)}
.cg-page code{font-family:var(--ds-font-family-code,monospace);font-size:12px;overflow-wrap:anywhere}.cg-page summary{cursor:pointer}.cg-page ul,.cg-page ol{margin:8px 0;padding-inline-start:20px}.cg-page li+li{margin-top:6px}.cg-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;border-radius:5px;padding:3px 7px;background:var(--cg-surface);border:1px solid var(--cg-border)}.cg-chip[data-tone=accent]{color:var(--dsw-alias-label-primary);background:var(--cg-tint);border-color:transparent}.cg-chip[data-tone=error]{color:var(--cg-error)}.cg-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.cg-inventory-section{margin:18px 0}.cg-page .cg-inventory-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 14px;background:var(--cg-surface);border-bottom:1px solid var(--cg-border)}.cg-inventory-heading>span:first-child{display:flex;gap:8px;align-items:center}.cg-count{font-size:12px;font-weight:400;color:var(--cg-muted);font-variant-numeric:tabular-nums}.cg-panel{border:1px solid var(--cg-border);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}.cg-page .cg-capabilities{list-style:none;margin:0;padding:0}.cg-page .cg-capabilities>li{min-width:0;margin:0;padding:0}.cg-page .cg-capabilities>li+li{margin:0;border-top:1px solid var(--dsw-alias-border-l2)}
.cg-page .cg-capability>summary{display:grid;grid-template-columns:minmax(0,1fr) auto 16px;align-items:center;gap:10px;padding:11px 14px;list-style:none;text-align:start}.cg-page summary::-webkit-details-marker{display:none}.cg-page .cg-capability>summary:hover,.cg-record>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}.cg-capability-name{min-width:0}.cg-capability-name strong{display:block;font-size:13px;font-weight:550;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.cg-capability-name small{display:block;margin-top:3px;font-size:11px;color:var(--cg-muted)}.cg-capability-state{max-width:12em;overflow-wrap:anywhere}.cg-chevron{width:16px;height:16px;color:var(--cg-muted);flex-shrink:0;transition:transform .15s ease-out}.cg-capability[open]>summary .cg-chevron,.cg-record[open]>summary .cg-chevron{transform:rotate(90deg)}.cg-capability[open]>summary{background:var(--cg-tint)}
.cg-capability-body{padding:12px 14px 14px;font-size:12px;overflow-wrap:anywhere}.cg-page .cg-capability-description{color:var(--cg-muted);line-height:1.6;margin:0 0 12px}.cg-page .cg-capability-fullname{font-weight:550;margin:0 0 8px}.cg-capability-body dl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px 12px;margin:0;padding:12px;background:var(--cg-surface);border-radius:6px}.cg-capability-body dt{color:var(--cg-muted)}.cg-capability-body dd{margin:0;min-width:0;overflow-wrap:anywhere}.cg-page .cg-tool-list{list-style:none;padding:0;margin:12px 0 0}.cg-page .cg-tool-list>li{margin:0;padding:8px 0}.cg-page .cg-tool-list>li+li{border-top:1px solid var(--dsw-alias-border-l2)}.cg-tool-list p{color:var(--cg-muted);margin-top:4px}.cg-page .cg-inventory-empty{padding:20px 14px;color:var(--cg-muted);font-size:12px}
.cg-disclosure{font-size:12px;color:var(--cg-muted);padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}.cg-disclosure>summary{width:fit-content;color:var(--dsw-alias-label-primary)}.cg-disclosure[open]>summary{margin-bottom:12px}.cg-disclosure p+p{margin-top:8px}.cg-disclosure dl,.cg-record dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px 12px;margin:12px 0}.cg-disclosure dt,.cg-record dt{color:var(--cg-muted)}.cg-disclosure dd,.cg-record dd{margin:0;overflow-wrap:anywhere}.cg-roots{list-style:none;padding:0!important}.cg-roots li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.cg-roots code{color:var(--dsw-alias-label-primary)}
.cg-list-heading{display:flex;gap:12px;align-items:baseline;justify-content:space-between;padding:12px 14px;background:var(--cg-surface)}.cg-list-heading span,.cg-footnote{font-size:12px;color:var(--cg-muted)}.cg-list-heading span{font-variant-numeric:tabular-nums}.cg-filters{padding:0 14px;align-items:center}.cg-filters label{flex-direction:row;align-items:center;gap:7px}.cg-page .cg-footnote{margin:0 0 12px;font-size:12px;color:var(--cg-muted)}.cg-workbench{margin:16px 0}.cg-workbench>.cg-footnote{padding:0 14px}.cg-record{border-top:1px solid var(--dsw-alias-border-l2)}.cg-record>summary{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px 14px;list-style:none}.cg-record-title{min-width:0}.cg-record-title>strong{display:block;font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.cg-record-title small{display:block;color:var(--cg-muted);font-size:11px;margin-top:3px}.cg-record-result{text-align:end;font-size:12px}.cg-record-result time{display:block;color:var(--cg-muted);margin-top:3px}.cg-record-body{padding:0 14px 12px;overflow-wrap:anywhere}.cg-record dl{font-size:12px;padding:12px;background:var(--cg-surface);border-radius:6px}.cg-review{display:flex;gap:10px;align-items:center;margin:12px 0}.cg-review label{display:flex;gap:8px;align-items:center}.cg-timestamp{font-size:11px;font-variant-numeric:tabular-nums}.cg-empty{padding:28px 16px;text-align:center;background:var(--cg-surface);color:var(--cg-muted)}.cg-empty strong{display:block;font-weight:500;color:var(--dsw-alias-label-primary);margin-bottom:6px}.cg-empty p{font-size:12px}
.cg-pagination{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--cg-border);background:var(--dsw-alias-bg-layer-1);font-size:12px}.cg-pagination label{display:flex;gap:6px;align-items:center;color:var(--cg-muted)}.cg-pagination label select{min-height:30px;padding:3px 6px}.cg-jump input{width:64px;min-height:30px!important;padding:3px 6px!important}.cg-page-controls{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.cg-page-controls>span{color:var(--cg-muted);font-variant-numeric:tabular-nums}.cg-page-controls button{min-height:30px;padding:4px 8px}.cg-update{min-height:20px;font-size:12px;color:var(--cg-muted);margin-bottom:6px}.cg-alert-state{display:inline-flex;gap:4px;align-items:center}
@container(max-width:620px){.cg-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.cg-stats dl.cg-primary{grid-column:span 1}.cg-stats dl{padding:12px}.cg-stats .cg-primary dd{font-size:28px}.cg-scope-meta{margin-inline-start:0}.cg-overview dl{padding:0 12px}.cg-record>summary{gap:8px}.cg-scope label{flex-wrap:wrap}}
@container(max-width:400px){.cg-nav{grid-template-columns:repeat(2,minmax(0,1fr))}.cg-toolbar{gap:8px}.cg-grow{flex-basis:100%}.cg-overview dt .cg-icon{display:none}.cg-overview dl{padding:0 9px}.cg-overview dd{font-size:23px}.cg-record>summary{grid-template-columns:16px minmax(0,1fr)}.cg-record-result{grid-column:2;text-align:start}.cg-record-result time{display:inline;margin-inline-start:8px}.cg-capability-state{max-width:8em}.cg-pagination{align-items:start}.cg-page-controls{width:100%;justify-content:space-between}.cg-scope label{flex-direction:column;align-items:start}.cg-header p{max-width:20em}}
@media(prefers-reduced-motion:reduce){.cg-chevron{transition:none}}@media(forced-colors:active){.cg-nav button[aria-pressed=true]{border:2px solid Highlight}.cg-page :focus-visible{outline-color:Highlight}}
`
    function Icon({ name, className = 'cg-icon' }) {
      const paths = { network: 'M6 17 11 7m2 0 5 10M7 18h10M13 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM7 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm14 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
        layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5', box: 'm12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5m-9 5v9',
        chevron: 'm9 5 7 7-7 7', refresh: 'M20 8a8 8 0 1 0 0 8m0-13v5h-5', shield: 'M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6' }
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', className, 'aria-hidden': true }, h('path', { d: paths[name] }))
    }
    function Metric({ title, children, hint, primary, warning }) { return h('dl', { className: `${primary ? 'cg-primary ' : ''}${warning ? 'cg-error' : ''}` }, h('dt', null, title), h('dd', null, children), hint && h('small', null, hint)) }
    function Pagination({ title, total, offset, limit, onPage, onSize, busy = false }) {
      const page = Math.floor(offset / limit) + 1
      const pages = Math.max(1, Math.ceil(total / limit))
      const [jump, setJump] = useState('')
      const go = () => {
        const destination = Number(jump)
        if (Number.isInteger(destination) && destination >= 1 && destination <= pages) { onPage((destination - 1) * limit); setJump('') }
      }
      return h('nav', { className: 'cg-pagination', 'aria-label': `${title}分页` },
        h('span', { className: 'cg-count', role: 'status' }, total ? `${offset + 1}–${Math.min(offset + limit, total)} / ${total} 项` : '0 项'),
        h('div', { className: 'cg-page-controls' },
          onSize && h('label', null, '每页', h('select', { value: limit, disabled: busy, onChange: e => onSize(Number(e.target.value)), 'aria-label': `${title}每页数量` }, [10, 20, 50].map(size => h('option', { key: size, value: size }, `${size} 条`)))),
          h('button', { type: 'button', disabled: busy || page <= 1, onClick: () => onPage(0), 'aria-label': `${title}首页` }, '首页'),
          h('button', { type: 'button', disabled: busy || page <= 1, onClick: () => onPage(Math.max(0, offset - limit)), 'aria-label': `${title}上一页` }, '上一页'),
          h('span', null, `${page} / ${pages} 页`),
          h('button', { type: 'button', disabled: busy || page >= pages, onClick: () => onPage(offset + limit), 'aria-label': `${title}下一页` }, '下一页'),
          h('button', { type: 'button', disabled: busy || page >= pages, onClick: () => onPage((pages - 1) * limit), 'aria-label': `${title}末页` }, '末页')),
        pages > 5 && h('label', { className: 'cg-jump' }, '跳至', h('input', { type: 'number', min: 1, max: pages, step: 1, value: jump, disabled: busy, 'aria-label': `${title}跳转页码`, onChange: e => setJump(e.target.value), onKeyDown: e => { if (e.key === 'Enter') go() } }), h('button', { type: 'button', disabled: busy || !Number.isInteger(Number(jump)) || Number(jump) < 1 || Number(jump) > pages, onClick: go }, '前往')))
    }
    function InventorySection({ title, count, total, query, children }) {
      const [offset, setOffset] = useState(0)
      const [limit, setLimit] = useState(10)
      const effective = Math.min(offset, Math.max(0, Math.ceil(count / limit) - 1) * limit)
      const visible = React.Children.toArray(children).slice(effective, effective + limit)
      return h('section', { className: 'cg-inventory-section cg-panel', 'aria-label': title },
        h('h3', { className: 'cg-inventory-heading' }, h('span', null, h(Icon, { name: title === 'MCP 服务' ? 'box' : 'layers' }), title), h('span', { className: 'cg-count' }, query ? `${count} / ${total}` : total)),
        count ? h('div', { className: 'cg-inventory-list' }, h('ul', { className: 'cg-capabilities' }, visible)) : h('p', { className: 'cg-inventory-empty' }, query ? '没有符合条件的能力，可清除筛选查看全部。' : '此范围尚未发现可列出的能力。'),
        count > 10 && h(Pagination, { title, total: count, offset: effective, limit, onPage: setOffset, onSize: size => { setLimit(size); setOffset(0) } }))
    }
    function ToolList({ tools, name }) {
      const [offset, setOffset] = useState(0)
      const effective = Math.min(offset, Math.max(0, Math.ceil(tools.length / 10) - 1) * 10)
      return h('div', null, h('ul', { className: 'cg-tool-list', 'aria-label': `${name} 的工具` }, tools.slice(effective, effective + 10).map(tool => h('li', { key: tool.name }, h('code', null, tool.name), h('p', null, tool.description)))),
        tools.length > 10 && h(Pagination, { title: `${name}工具`, total: tools.length, offset: effective, limit: 10, onPage: setOffset }))
    }
    function Inventory({ inventory, query, kind = '', management = '' }) {
      const match = row => `${row.name} ${row.description ?? ''} ${row.source ?? ''}`.toLowerCase().includes(query.toLowerCase())
      const managedMatch = row => !management || (management === 'managed' ? row.managed : !row.managed)
      const skills = inventory.skills.filter(row => match(row) && managedMatch(row))
      const servers = inventory.mcp.filter(x => managedMatch(x) && (match(x) || x.tools.some(match)))
      const filterKey = `${query}:${kind}:${management}`
      return h(React.Fragment, null,
        !inventory.nativeSkillsComplete && h('p', { className: 'cg-notice cg-error', role: 'status' }, '技能发现未完成。清单可能缺项，当前状态不能视为完整接入结果。'),
        inventory.skillRoots.some(root => root.state === 'error') && h('p', { className: 'cg-notice cg-error', role: 'status' }, '部分受管技能目录读取失败，到“配置”查看目录的发现状态。'),
        inventory.scope === 'host-only' && h('p', { className: 'cg-notice' }, '当前没有活动会话，显示宿主范围；尚不能确认会话预设提供的能力。'),
        inventory.mcp.some(server => ['plugin_failed', 'no_tools_observed'].includes(server.state)) && h('p', { className: 'cg-notice', role: 'status' }, `MCP 观察：${inventory.mcp.filter(server => server.state === 'plugin_failed').length} 个启动失败，${inventory.mcp.filter(server => server.state === 'no_tools_observed').length} 个未观察到工具。可按名称筛选定位；未观察到工具不等于离线。`),
        inventory.mcpConfigurationObserved === false && h('p', { className: 'cg-muted' }, '当前未取得加载器配置，MCP 清单由受管配置与会话已注册工具组成；其他尚未加载的服务可能未列出。'),
        kind !== 'skill' && h(InventorySection, { key: `mcp:${filterKey}`, title: 'MCP 服务', count: servers.length, total: inventory.mcp.length, query: query || management }, servers.map(server => h('li', { key: server.name },
          h('details', { className: 'cg-capability' },
            h('summary', null,
              h('span', { className: 'cg-capability-name' }, h('strong', { title: server.name }, server.name),
                h('small', { className: server.state === 'plugin_failed' ? 'cg-error' : undefined }, `${server.toolCount} 个工具 · ${label(server.state)}`)),
              h('span', { className: 'cg-capability-state cg-chip', 'data-tone': server.managed ? 'accent' : undefined }, server.managed ? '网关接管' : '原生保留'),
              h(Icon, { name: 'chevron', className: 'cg-chevron' })),
            h('div', { className: 'cg-capability-body' },
              h('p', { className: 'cg-capability-fullname' }, server.name),
              server.state === 'no_tools_observed' && h('p', { className: 'cg-notice' }, '连接、权限或加载情况待确认；不能据此判定离线。'),
              h('dl', null, h('dt', null, '目录展示'), h('dd', null, label(server.presentation)), h('dt', null, '观察状态'), h('dd', null, label(server.state))),
              h(ToolList, { key: query, name: server.name, tools: server.tools.filter(x => !query || match(x) || match(server)) })))))),
        kind !== 'mcp' && h(InventorySection, { key: `skill:${filterKey}`, title: 'Skills', count: skills.length, total: inventory.skills.length, query: query || management }, skills.map(skill => h('li', { key: `${skill.name}:${skill.path}` },
          h('details', { className: 'cg-capability' },
            h('summary', null,
              h('span', { className: 'cg-capability-name' }, h('strong', { title: skill.name }, skill.name)),
              h('span', { className: 'cg-capability-state cg-chip', 'data-tone': skill.managed ? 'accent' : undefined }, label(skill.state)),
              h(Icon, { name: 'chevron', className: 'cg-chevron' })),
            h('div', { className: 'cg-capability-body' },
              h('p', { className: 'cg-capability-fullname' }, skill.name),
              h('p', { className: 'cg-capability-description' }, skill.description),
              h('dl', null,
                h('dt', null, '来源'), h('dd', null, skill.source),
                h('dt', null, '调用方式'), h('dd', null, skill.managed ? '按需通过网关加载' : skill.modelInvocable === true ? '模型可选' : skill.modelInvocable === false ? '模型不可自动选用' : '待确认'),
                h('dt', null, '用户调用'), h('dd', null, skill.userInvocable ? '保留用户显式调用' : '未开放用户显式调用'),
                h('dt', null, '位置'), h('dd', null, h('code', null, skill.path ?? '无文件路径')),
                h('dt', null, '提供者'), h('dd', null, skill.provider ?? '未纳入当前会话'))))))))
    }

    function Records({ events, onReview, saving = null, filtered = false }) {
      if (!events.length) return h('div', { className: 'cg-empty' }, h('strong', null, filtered ? '没有符合筛选条件的记录' : '这个范围还没有调用记录'),
        h('p', null, filtered ? '调整结果或操作筛选，查看其他记录。' : '通过网关搜索或调用后，刷新即可查看。记录从启用日志功能后开始。'))
      return h('div', null, events.map(row => h('details', { key: row.id, className: 'cg-record' },
        h('summary', null, h(Icon, { name: 'chevron', className: 'cg-chevron' }),
          h('span', { className: 'cg-record-title' }, h('strong', { title: row.target ?? undefined }, row.target ?? (row.action === 'search' ? row.discoveryIncomplete ? `发现不完整 · ${row.candidates.length} 个候选` : row.matchCount === 0 && row.candidates.length ? `无直接匹配 · ${row.candidates.length} 个路由入口` : row.matchCount === null ? '未提供查询词' : `${row.matchCount ?? '未知'} 个匹配` : '未解析目标')), h('small', null, label(row.action), ' · ', row.route === 'gateway' ? '网关' : '原生直接调用')),
          h('span', { className: 'cg-record-result' }, h('span', { className: 'cg-chip', 'data-tone': row.outcome === 'error' ? 'error' : undefined }, h('i', { className: 'cg-dot', 'aria-hidden': true }), label(row.outcome)), ' · ', row.durationMs === null ? '耗时未知' : `${row.durationMs} ms`,
            h('time', { className: 'cg-timestamp', dateTime: new Date(row.at).toISOString() }, time(row.at)))),
        h('div', { className: 'cg-record-body' }, h('dl', null,
          h('dt', null, '记录编号'), h('dd', null, h('code', null, row.id)),
          h('dt', null, '会话 / 调用'), h('dd', null, h('code', null, `${row.agentId ?? '宿主'} / ${row.callId ?? '—'}`)),
          h('dt', null, '路径'), h('dd', null, row.route === 'gateway' ? '网关' : '原生直接调用'),
          h('dt', null, '实际转发'), h('dd', null, row.action !== 'call' ? '不适用' : !row.dispatched ? '未进入工具执行阶段' : h('code', null, row.actualTarget ?? '未知')),
          h('dt', null, '目标一致性'), h('dd', null, row.routeMatches === null ? '没有转发样本' : row.routeMatches ? '请求目标与实际转发一致' : '目标不一致'),
          h('dt', null, '最近搜索'), h('dd', null, row.searchId ? `${row.searchId} · ${row.candidateRank > 0 ? `候选第 ${row.candidateRank} 位` : '不在候选中'}` : '无 10 分钟内可关联搜索；可能是显式指定'),
          h('dt', null, '错误类别'), h('dd', null, row.errorCode ?? '—')),
        row.candidates.length > 0 && h('div', null, '展示给 Agent 的候选：', h('ol', null, row.candidates.map(item => h('li', { key: `${item.kind}:${item.name}` }, `${item.kind} · ${item.name}`)))),
        row.route === 'gateway' && ['load', 'call'].includes(row.action) && h('div', { className: 'cg-review' }, h('label', null, '选用是否合适', h('select', {
          value: row.verdict, disabled: saving !== null, onChange: event => onReview(row.id, event.target.value),
        }, ['unreviewed', 'correct', 'wrong'].map(value => h('option', { key: value, value }, label(value))))))))))
    }
    function ChoiceList({ title, choices, selected, onChange, disabled }) {
      const [filter, setFilter] = useState('')
      const [offset, setOffset] = useState(0)
      const matches = choices.filter(value => value.toLowerCase().includes(filter.toLowerCase()))
      const page = Math.min(offset, Math.max(0, Math.ceil(matches.length / 10) - 1) * 10)
      return h('fieldset', { className: 'cg-choices', disabled }, h('legend', null, title),
        h('label', { className: 'cg-field' }, `筛选${title}`, h('input', { type: 'text', value: filter, onChange: e => { setFilter(e.target.value); setOffset(0) } })),
        !matches.length && h('p', { className: 'cg-muted' }, choices.length ? '没有符合条件的项目。' : '当前未发现可选项目。'),
        h('ul', null, matches.slice(page, page + 10).map(value => h('li', { key: value },
          h('label', null, h('input', { type: 'checkbox', checked: selected.includes(value), onChange: e => onChange(e.target.checked ? [...selected, value] : selected.filter(item => item !== value)) }), h('code', null, value))))),
        matches.length > 10 && h(Pagination, { title, total: matches.length, offset: page, limit: 10, busy: disabled, onPage: setOffset }))
    }
    function ScopeEditor({ management, inventory, config, api, onSaved, disabled }) {
      const [baseline, setBaseline] = useState(management)
      const [roots, setRoots] = useState(management.skillRoots)
      const [servers, setServers] = useState(management.mcpServers)
      const [directory, setDirectory] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const stale = baseline.revision !== management.revision
      const delta = (before, after) => ({ added: after.filter(item => !before.includes(item)), removed: before.filter(item => !after.includes(item)) })
      const changes = [delta(baseline.skillRoots, roots), delta(baseline.mcpServers, servers)]
      const dirty = changes.some(change => change.added.length || change.removed.length)
      const locked = disabled || busy || stale || !management.writable
      const reset = () => { setBaseline(management); setRoots(management.skillRoots); setServers(management.mcpServers); setDirectory(''); setError(''); setMessage('') }
      const save = async e => {
        e.preventDefault()
        if (locked || !dirty) return
        setBusy(true); setError(''); setMessage('')
        try {
          const result = await api.configure({ revision: baseline.revision, skillRoots: roots, mcpServers: servers })
          setMessage(result.message)
          const next = await onSaved()
          if (next?.management) { setBaseline(next.management); setRoots(next.management.skillRoots); setServers(next.management.mcpServers) }
        } catch (failure) { setError(`${failure.message ?? failure}。请刷新确认当前配置，再重新载入选择；尚未确认保存成功。`) }
        finally { setBusy(false) }
      }
      return h('section', { className: 'cg-feature', 'aria-label': '接管范围' }, h('h3', null, '选择接管范围'),
        h('p', { className: 'cg-footnote' }, '仅接管勾选的 MCP 服务与技能目录。目录内后续新增技能也会纳入；内置、项目和个人技能保留原生优先级。取消勾选会恢复原生提供。'),
        h('p', { className: 'cg-footnote' }, '保存范围对整个插件实例生效，不随上方查看会话切换。'),
        h('p', { className: 'cg-footnote' }, '技能候选目录由当前可见技能的文件位置推导，请核对路径。未发现的目录可手动添加；未观察到的已配置项目仍保留勾选。'),
        !management.writable && h('p', { className: 'cg-notice', role: 'status' }, '此宿主未提供配置保存接口，请通过宿主配置管理修改范围。现有接管继续生效。'),
        (config?.wrapSkills === false || config?.wrapMcp === false) && h('p', { className: 'cg-notice' }, '部分接管功能已在宿主配置中关闭。此处保存范围不会开启该开关。'),
        stale && h('p', { className: 'cg-notice', role: 'status' }, '配置已更新。请重新载入选择后继续编辑。'),
        h('form', { onSubmit: save, 'aria-busy': busy },
          h('div', { className: 'cg-editor-grid' },
            h(ChoiceList, { title: '技能目录', choices: [...new Set([...management.rootChoices, ...roots])].sort(), selected: roots, onChange: setRoots, disabled: locked }),
            h(ChoiceList, { title: 'MCP 服务', choices: [...new Set([...inventory.mcp.map(row => row.name), ...servers])].sort(), selected: servers, onChange: setServers, disabled: locked })),
          h('div', { className: 'cg-toolbar' }, h('label', { className: 'cg-grow' }, '添加技能目录', h('input', { type: 'text', value: directory, disabled: locked, onChange: e => setDirectory(e.target.value), placeholder: '输入本机目录路径' })),
            h('button', { type: 'button', disabled: locked || !directory.trim(), onClick: () => { setRoots([...new Set([...roots, directory.trim()])]); setDirectory(''); setMessage('') } }, '加入待保存范围')),
          h('div', { className: 'cg-notice', 'aria-label': '接管变更预览' },
            !dirty ? '接管范围未变化。' : changes.map((change, index) => h('div', { key: index }, `${index ? 'MCP 服务' : '技能目录'}：新增 ${change.added.length}，移除 ${change.removed.length}`,
              change.added.length > 0 && h('p', null, '新增：', h('code', null, change.added.join('、'))),
              change.removed.length > 0 && h('p', null, '移除：', h('code', null, change.removed.join('、')))))),
          h('div', { className: 'cg-toolbar' }, h('button', { type: 'submit', disabled: locked || !dirty }, busy ? '正在保存接管范围…' : '保存接管范围'),
            h('button', { type: 'button', disabled: busy, onClick: reset }, '重新载入选择')),
          h('p', { role: 'status', className: 'cg-footnote' }, message),
          error && h('p', { role: 'alert', className: 'cg-notice cg-error' }, error)))
    }
    function SearchLab({ api, agentId, disabled }) {
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)
      const request = useRef(0)
      useEffect(() => () => { request.current++ }, [])
      const clear = () => { request.current++; setResult(null); setError(''); setBusy(false) }
      const search = async e => {
        e.preventDefault()
        if (disabled || busy) return
        const revision = ++request.current
        if (!query.trim()) { setError('请输入任务、能力名称或短关键词。'); return }
        setBusy(true); setError(''); setResult(null)
        try {
          const next = await api.probe({ query: query.trim(), ...(kind ? { kind } : {}), ...(agentId ? { agentId } : {}) })
          if (request.current === revision) setResult(next)
        } catch (failure) { if (request.current === revision) setError(String(failure.message ?? failure)) }
        finally { if (request.current === revision) setBusy(false) }
      }
      return h('details', { className: 'cg-disclosure cg-feature' }, h('summary', null, '搜索试验区'),
        h('p', { className: 'cg-footnote' }, '使用当前查看会话的网关检索规则，只搜索已接管能力。不执行下游工具，不写入调用记录。'),
        h('form', { onSubmit: search, 'aria-busy': busy }, h('div', { className: 'cg-toolbar' },
          h('label', { className: 'cg-grow' }, '试验查询', h('input', { type: 'text', value: query, maxLength: 1000, 'aria-invalid': Boolean(error), 'aria-describedby': 'cg-probe-error', onChange: e => { clear(); setQuery(e.target.value) }, placeholder: '输入任务、能力名称或短关键词' })),
          h('label', null, '试验类型', h('select', { value: kind, onChange: e => { clear(); setKind(e.target.value) } }, h('option', { value: '' }, '全部能力'), h('option', { value: 'skill' }, '仅技能'), h('option', { value: 'mcp' }, '仅 MCP'))),
          h('button', { type: 'submit', disabled: disabled || busy }, busy ? '正在搜索…' : '试验搜索'))),
        h('p', { id: 'cg-probe-error', role: error ? 'alert' : undefined, className: 'cg-error' }, error),
        h('p', { role: 'status', className: 'cg-footnote' }, result ? ({ matched: `匹配 ${result.matchCount} 项，显示前 ${result.results.length} 项。`, not_found: '已接管范围内无匹配。请检查接管范围、别名，或改用名称与短关键词。', routing: '无直接匹配。以下仅是可继续检索的 MCP 入口，尚未确认下游能力。', incomplete: '能力发现不完整，不能据此判断未命中。请先查看接入异常。' })[result.state] : busy ? '正在检索当前接管范围…' : ''),
        result?.scope === 'host-only' && h('p', { className: 'cg-notice' }, '当前没有活动会话，结果仅代表宿主范围。'),
        result?.aliasCoverageComplete === false && h('p', { className: 'cg-notice cg-error' }, '别名覆盖不完整，未命中不代表该能力不存在。请修正上方的别名配置异常后重试。'),
        result?.unavailable?.length > 0 && h('p', { className: 'cg-notice cg-error' }, result.unavailable.map(item => `${item.kind}：${item.code}`).join('；')),
        result?.results.length > 0 && h('ol', { className: 'cg-probe-results' }, result.results.map(row => h('li', { key: `${row.kind}:${row.name}` },
          h('strong', null, row.name), h('span', { className: 'cg-chip' }, row.kind === 'skill' ? '技能' : 'MCP'),
          h('p', null, row.description), h('small', { className: 'cg-muted' }, `${({ exact: '完整名称匹配', alias: '别名匹配', lexical: '名称或说明词法匹配', routing: '继续检索的路由入口' })[row.reason]}${row.score === null ? '' : ` · 排序分 ${Number(row.score).toFixed(1)}（非置信度）`}`)))))
    }
    function Diagnostics({ inventory, activity, onFilter }) {
      const stats = activity.stats
      const total = inventory.mcp.reduce((sum, row) => sum + row.toolCount, 0)
      const hidden = inventory.mcp.filter(row => ['gateway', 'gateway-sdk'].includes(row.presentation)).reduce((sum, row) => sum + row.toolCount, 0)
      const presentationUnknown = inventory.mode === 'unknown'
      const managedSkills = inventory.skills.filter(row => row.managed).length
      const issues = []
      const add = (condition, text, action) => { if (condition) issues.push({ text, action }) }
      add(!inventory.nativeSkillsComplete, '技能发现不完整。请查看受管目录与宿主的技能加载情况。')
      add(inventory.skillRoots.some(root => root.state === 'error'), '技能目录读取失败。请到“配置”核对目录路径与权限。')
      add(inventory.configDiagnostics?.complete === false, '别名配置不完整。请按“配置”中显示的文件序号修正后重载。')
      add(inventory.mcp.some(row => row.state === 'plugin_failed'), '有 MCP 插件启动失败。请在宿主插件管理中检查启动日志。')
      add(inventory.mcp.some(row => row.state === 'no_tools_observed'), '部分 MCP 未观察到工具。请检查加载、连接与会话权限；这不等同于离线。')
      add(inventory.mcpConfigurationObserved === false, 'MCP 配置发现不完整。未加载的服务可能没有列出。')
      add(inventory.mcp.some(row => row.presentation === 'native-sdk'), '当前宿主未支持 PTC 声明精简。受管 MCP 仍原生暴露，请核对宿主兼容版本。')
      add(inventory.mcp.some(row => row.managed && row.presentation === 'native'), '原生模式保留受管 MCP 的工具声明，仍可通过网关检索和调用。')
      add(presentationUnknown, '当前宿主无法确认 MCP 工具声明。')
      add(!activity.storage.complete, '日志样本不完整，当前统计不能代表全部调用。请检查日志读取与写入状态。')
      add(stats.searchMisses > 0, `${stats.searchMisses} 次搜索未命中。请用搜索试验区检查名称、范围与别名。`, { action: 'search' })
      add(stats.searchIncomplete > 0, `${stats.searchIncomplete} 次搜索发现不完整。请先处理接入异常，再评价检索质量。`, { action: 'search' })
      add(stats.directCalls > 0, `${stats.directCalls} 次受管能力走原生直接调用。可能来自显式调用，请检查记录后判断。`)
      add(stats.routeMismatches > 0, `${stats.routeMismatches} 次转发目标不一致。请展开调用记录核对。`, { action: 'call' })
      add(stats.reviewedWrong > 0, `${stats.reviewedWrong} 次选用被标记为需修正。请结合候选与实际目标复核。`)
      return h('section', { className: 'cg-feature cg-panel', 'aria-label': '效果与异常诊断' },
        h('div', { className: 'cg-list-heading' }, h('h3', null, '效果与异常诊断')),
        h('div', { className: 'cg-feature-body' },
          h('p', null, `当前查看范围内，MCP 原生声明预计 ${total} → ${presentationUnknown ? '待确认' : total - hidden} 项；${managedSkills} 项技能由网关按需提供。另保留一个 capability 入口。`),
          h('p', { className: 'cg-footnote' }, '按当前注册清单与呈现模式计算，不代表 token 或费用节省。技能与 MCP 计数不相加。调用诊断沿用记录范围，不受列表筛选影响。'),
          !(stats.operations >= 20) && h('p', { className: 'cg-footnote' }, '调用样本少于 20 条，暂不据此判断趋势。'),
          !issues.length && h('p', { role: 'status' }, '当前快照与保留记录中未发现上述异常；不代表上游实时健康。'),
          issues.length > 0 && h('ul', { className: 'cg-diagnostics' }, issues.map((issue, index) => h('li', { key: index }, issue.text,
            issue.action && onFilter && h('button', { type: 'button', onClick: () => onFilter(issue.action) }, '查看相关记录')))),
          activity.errors?.length > 0 && h('details', null, h('summary', null, '错误类别与处理建议'), h('ul', null, activity.errors.map(row => h('li', { key: row.name },
            `${row.name}：${row.count} 次。${({ invalid_arguments: '检查工具参数与 schema。', unavailable: '检查接管范围、工具注册与 schema 支持情况。', dependency_missing: '检查技能文件与依赖。', execution_failed: '检查下游工具的原始调用记录。', cancelled: '调用已取消，请按任务需要重试。', native_error: '检查宿主日志，确认原生执行或发现错误。', not_found: '检查能力名称、别名与接管范围。' })[row.name] ?? '展开调用记录，检查错误类别。'}`))))))
    }
    function GatewayPanel({ api, initialSnapshot = null, initialSection = 'inventory' }) {
      const [data, setData] = useState(initialSnapshot)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [saving, setSaving] = useState(null)
      const [exporting, setExporting] = useState(null)
      const [section, setSection] = useState(initialSection === 'activity' ? 'logs' : initialSection)
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState('')
      const [management, setManagement] = useState('')
      const [agentId, setAgentId] = useState('')
      const [historyScope, setHistoryScope] = useState('all')
      const [outcome, setOutcome] = useState('')
      const [action, setAction] = useState('')
      const [pageRequest, setPageRequest] = useState({ offset: 0, limit: 10 })
      const revision = useRef(0)
      const refresh = useCallback(async () => {
        const request = ++revision.current
        setBusy(true); setError('')
        try {
          const next = await api.snapshot({ historyScope, ...pageRequest, ...(agentId ? { agentId } : {}), ...(outcome ? { outcome } : {}), ...(action ? { action } : {}) })
          if (revision.current === request) { setData(next); return next }
        } catch (failure) { if (revision.current === request) setError(String(failure.message ?? failure)) }
        finally { if (revision.current === request) setBusy(false) }
      }, [api, agentId, historyScope, outcome, action, pageRequest])
      useEffect(() => { refresh(); return () => { revision.current++ } }, [refresh])
      const firstPage = () => setPageRequest(current => ({ offset: 0, limit: current.limit }))
      const review = async (eventId, verdict) => {
        setSaving(eventId); setError('')
        try { await api.review({ eventId, verdict }); await refresh() }
        catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setSaving(null) }
      }
      const exportReport = async format => {
        setExporting(format); setError('')
        try {
          const selectedAgent = agentId || data?.inventory.agentId
          if (historyScope === 'selected' && !selectedAgent) throw new Error('请先选择活动会话，再导出该会话的周报。')
          const file = await api.report({ format, historyScope, ...(historyScope === 'selected' ? { agentId: selectedAgent } : {}) })
          if (!saveFile(file.filename, file.content, format === 'json' ? 'application/json' : 'text/markdown')) {
            setError('当前环境不支持下载；可用 capability action=report 取得调用会话的周报，范围可能与页面不同。')
          }
        } catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setExporting(null) }
      }
      const locked = busy || saving !== null
      const inventory = data?.inventory
      const activity = data?.activity
      const stats = activity?.stats
      const offset = activity?.offset ?? 0
      const limit = activity?.limit ?? pageRequest.limit
      const inventoryFiltered = Boolean(query || kind || management)
      const sections = [
        ['inventory', '能力清单', '查看当前会话中，哪些 MCP 服务和技能由网关接管。'],
        ['config', '配置', '选择网关接管的 MCP 服务和技能目录，并试搜已接管的能力。'],
        ['stats', '使用统计', '查看最近 7 天的搜索、调用和异常汇总。'],
        ['logs', '运行日志', '查看网关记录的搜索、技能加载和 MCP 调用明细。'],
      ]
      const [, title, description] = sections.find(([id]) => id === section) ?? sections[0]
      const openLogs = filters => { setOutcome(''); setAction(filters.action || ''); setSection('logs'); firstPage() }
      return h('section', { className: 'cg-page', 'aria-label': '能力网关', 'aria-busy': busy },
        h('div', { className: 'cg-header' }, h('div', null, h('div', { className: 'cg-brand' }, h(Icon, { name: 'network' }), h('h2', null, '能力网关')), h('p', null, '管理网关接管范围，查看使用情况。')),
          h('button', { type: 'button', 'aria-label': '刷新快照', disabled: locked, onClick: firstPage }, h(Icon, { name: 'refresh' }), busy ? '正在刷新…' : '刷新')),

        error && h('p', { className: 'cg-notice cg-error', role: 'alert' }, `读取或保存失败：${error}。${data ? '下方保留上次读取的快照，可能与当前筛选不同；选择“刷新”重试。' : '请确认插件已启用后重试。'}`),
        h('div', { className: 'cg-nav', role: 'group', 'aria-label': '查看内容' }, sections.map(([id, title]) => h('button', { key: id, type: 'button', 'aria-pressed': section === id, onClick: () => setSection(id) }, title))),
        h('p', { className: 'cg-update', role: 'status' }, busy && data ? '正在更新，以下暂为上次读取的快照…' : saving ? '正在保存标记…' : ''),
        h('div', { className: 'cg-view-heading' }, h('h3', null, title), h('p', null, description)),
        h('div', { className: 'cg-toolbar cg-scope' }, h('label', null, section === 'config' ? '发现与试搜会话' : '查看会话', h('select', { value: agentId, disabled: locked, onChange: e => { setAgentId(e.target.value); firstPage() } },
          h('option', { value: '' }, '自动选择 / 无会话时查看宿主'), (data?.agents ?? []).map(agent => h('option', { key: agent.id, value: agent.id, title: agent.id }, agent.title ? `${agent.title} · ${shortSession(agent.id)}` : `会话 ${shortSession(agent.id)}`)))),
          inventory && h('span', { className: 'cg-timestamp cg-muted cg-scope-meta' }, `当前：${data.agents?.find(agent => agent.id === inventory.agentId)?.title || (inventory.agentId ? shortSession(inventory.agentId) : '宿主范围')} · 更新于 ${time(inventory.at)}`)),
        !data ? h('p', { role: 'status', className: 'cg-empty' }, busy ? '正在读取网关数据…' : '尚未读取网关数据。') : h(React.Fragment, null,
        h('div', { hidden: section !== 'config' },
          data.management ? h(ScopeEditor, { management: data.management, inventory, config: data.config, api, onSaved: refresh, disabled: locked || Boolean(error) }) : h('p', { className: 'cg-notice' }, '当前宿主未提供接管范围配置。'),
          section === 'config' && inventory.configDiagnostics?.complete === false && h('div', { className: 'cg-notice cg-error', role: 'status' },
          h('p', null, `别名配置有 ${inventory.configDiagnostics.total} 项异常，搜索覆盖不完整。修正对应配置或文件后，重新加载插件。`),
          h('ul', null, inventory.configDiagnostics.items.map((item, index) => h('li', { key: index },
            `${item.source === 'localAliases' ? '本机别名包' : `keywordPacks 第 ${item.index} 项`}：${({ file_missing: '文件不存在', file_unreadable: '无法读取文件', invalid_json: 'JSON 格式错误', invalid_pack: '应为技能名称到关键词数组的映射', invalid_entries: '包含无效条目' })[item.code] ?? item.code}${item.count ? `（${item.count} 条）` : ''}${item.entries?.length ? `，条目序号：${item.entries.join('、')}${item.count > item.entries.length ? '…' : ''}` : ''}`))),
          inventory.configDiagnostics.truncated && h('p', null, `当前显示 ${inventory.configDiagnostics.shown} 项，共 ${inventory.configDiagnostics.total} 项异常。`)),
          h('details', { className: 'cg-disclosure' }, h('summary', null, '已配置目录的发现状态'),
            h('ul', { className: 'cg-roots' }, inventory.skillRoots.map(root => h('li', { key: root.path }, h('code', null, root.path), h('span', { className: root.state === 'error' ? 'cg-error' : undefined }, root.state === 'error' ? `读取失败（${root.errorCode}）` : `${root.count} 项可供网关管理`))))),
          section === 'config' && h(SearchLab, { key: `${inventory.agentId}:${inventory.at}`, api, agentId: inventory.agentId, disabled: locked || Boolean(error) })),
        section === 'inventory' && h(React.Fragment, null,
          h('div', { className: 'cg-overview', 'aria-label': '接入总览' },
            [['box', '已接管 MCP 服务', inventory.mcp.filter(row => row.managed).length, `清单共 ${inventory.mcp.length} 个服务`], ['layers', '已接管技能', inventory.skills.filter(row => row.managed).length, `清单共 ${inventory.skills.length} 项技能`]].map(([icon, title, count, hint]) => h('dl', { key: title }, h('dt', null, h(Icon, { name: icon }), title), h('dd', null, count), h('small', null, hint)))),
          h('div', { className: 'cg-toolbar' }, h('label', { className: 'cg-grow' }, '筛选能力', h('input', { type: 'search', value: query, onChange: e => setQuery(e.target.value), placeholder: '名称、说明或来源' })),
            h('label', null, '能力类型', h('select', { value: kind, onChange: e => setKind(e.target.value) }, h('option', { value: '' }, '全部类型'), h('option', { value: 'skill' }, 'Skills'), h('option', { value: 'mcp' }, 'MCP'))),
            h('label', null, '管理方式', h('select', { value: management, onChange: e => setManagement(e.target.value) }, h('option', { value: '' }, '全部方式'), h('option', { value: 'managed' }, '网关管理'), h('option', { value: 'native' }, '未由网关管理'))),
            inventoryFiltered && h('button', { type: 'button', onClick: () => { setQuery(''); setKind(''); setManagement('') } }, '清除筛选')),
          h(Inventory, { inventory, query, kind, management })),
        (section === 'stats' || section === 'logs') && h(React.Fragment, null,
          h('div', { className: 'cg-toolbar cg-scope' }, h('label', null, '记录范围', h('select', { value: historyScope, disabled: locked, onChange: e => { setHistoryScope(e.target.value); firstPage() } }, h('option', { value: 'all' }, '全部会话'), h('option', { value: 'selected' }, '所选活动会话'))),
            h('span', { className: 'cg-chip cg-scope-meta' }, '最近 7 天')),
          !activity.storage.complete && h('p', { role: 'status', className: 'cg-notice cg-error' }, '记录样本不完整或持久化异常，统计只能代表当前可读取部分。', ` 损坏行 ${activity.storage.invalidLines}；写入失败次数 ${activity.storage.writeFailures ?? 0}；读取 ${activity.storage.readError ?? '正常'}；写入 ${activity.storage.writeError ?? '正常'}。`),
          section === 'stats' && stats.searchIncomplete > 0 && h('p', { role: 'status', className: 'cg-notice cg-error' }, `${stats.searchIncomplete} 次搜索的能力发现不完整，未计为未命中；当前未命中率不能代表完整检索质量。`),
          section === 'stats' ? h(React.Fragment, null,
          h('div', { className: 'cg-stats', 'aria-label': '转发统计' },
            h(Metric, { title: '网关 MCP 调用', primary: true, hint: stats.callRejected > 0 ? `${stats.callRejected} 次未转发` : '已观察到的终态调用' }, stats.calls),
            h(Metric, { title: '调用成功率', primary: true, hint: '分母为实际转发调用' }, percent(stats.callSuccessRate)),
            h(Metric, { title: '搜索未命中', hint: '未命中 / 搜索次数' }, `${stats.searchMisses} / ${stats.searchCount}`),
            h(Metric, { title: '候选内采用率', hint: '仅统计有关联搜索的选用' }, percent(stats.candidateAdoptionRate)),
            h(Metric, { title: '转发目标不一致', warning: stats.routeMismatches > 0, hint: '请求与实际调度名称' }, stats.routeMismatches),
            h(Metric, { title: '人工标记', warning: stats.reviewedWrong > 0, hint: '正确 / 需修正' }, `${stats.reviewedCorrect} / ${stats.reviewedWrong}`)),
          h('p', { className: 'cg-footnote' }, '如需评价能力选择，请在运行日志中展开对应记录。'),
          h('div', { className: 'cg-toolbar cg-export' },
            h('button', { type: 'button', 'aria-label': '导出 Markdown 周报', disabled: locked || exporting !== null || Boolean(error), onClick: () => exportReport('markdown') }, exporting === 'markdown' ? '正在生成…' : '导出周报'),
            h('button', { type: 'button', 'aria-label': '导出 JSON 周报', disabled: locked || exporting !== null || Boolean(error), onClick: () => exportReport('json') }, exporting === 'json' ? '正在生成…' : '导出 JSON'),
            h('p', { className: 'cg-footnote' }, `导出范围：${historyScope === 'selected' ? '所选活动会话' : '全部会话'}；结果和操作筛选不影响周报。只含计数、名称与状态，不含搜索原文或工具参数。`)),
          h('details', { className: 'cg-disclosure' }, h('summary', null, '统计口径'),
            h('p', null, `最近 7 天、最多 ${activity.storage.maxEvents} 条事件；统计按记录范围计算。发现不完整的搜索 ${stats.searchIncomplete ?? 0} 次，未计为未命中。候选采用样本 ${stats.correlatedSelections}（只统计返回过候选的搜索）；未关联搜索 ${stats.explicitOrUnlinked}；原生直接调用 ${stats.directCalls}。`),
            h('p', null, '“调用成功率”只以实际转发到工具的调用为分母，参数校验和可用性拒绝不算失败，但仍计入“网关 MCP 调用”和记录列表。“候选内采用率”观察有候选的搜索后 10 分钟内同一会话的选用情况，不判断语义正确性。Skill 加载成功不代表任务执行成功。无样本的比率显示为 —。')),
          h(Diagnostics, { inventory, activity, onFilter: openLogs })) :
          h('section', { className: 'cg-workbench cg-panel', 'aria-label': '调用记录' },
            h('div', { className: 'cg-list-heading' }, h('h3', null, '调用记录'), h('span', null, '最新在前')),
            h('div', { className: 'cg-toolbar cg-filters' },
              h('label', null, '结果', h('select', { value: outcome, disabled: locked, onChange: e => { setOutcome(e.target.value); firstPage() } }, h('option', { value: '' }, '全部结果'), ['success', 'error', 'cancelled'].map(value => h('option', { key: value, value }, label(value))))),
              h('label', null, '操作', h('select', { value: action, disabled: locked, onChange: e => { setAction(e.target.value); firstPage() } }, h('option', { value: '' }, '全部操作'), ['search', 'load', 'describe', 'call'].map(value => h('option', { key: value, value }, label(value))))),
              (outcome || action) && h('button', { type: 'button', disabled: locked, onClick: () => { setOutcome(''); setAction(''); firstPage() } }, '清除筛选')),
            h('p', { className: 'cg-footnote' }, '按结果或操作筛选记录。刷新查看最新记录。'),
            h('div', { className: 'cg-record-list' },
              h(Records, { events: activity.events, onReview: review, saving: locked ? '*' : saving, filtered: Boolean(outcome || action) })),
            h(Pagination, { title: '调用记录', total: activity.total, offset, limit, busy: locked || Boolean(error),
              onPage: next => setPageRequest({ offset: next, limit, ...(activity.anchorId ? { anchorId: activity.anchorId } : {}) }),
              onSize: size => setPageRequest({ offset: 0, limit: size }) }),
            h('details', { className: 'cg-disclosure' }, h('summary', null, '日志位置与保存内容'),
              h('p', null, '日志只保存调用元数据，包括操作、结果、耗时和错误类别。'),
              h('code', null, activity.storage.directory))))))

    }

    // Strict codecs are required by the installed DSH client Remote runtime.
    const PACKAGE = 'dsh-capability-gateway'
    const snapshotOptions = () => z.strictObject({
      agentId: z.string().optional(), historyScope: z.enum(['all', 'selected']).optional(),
      outcome: z.enum(['success', 'error', 'cancelled']).optional(),
      action: z.enum(['search', 'load', 'describe', 'call']).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
      anchorId: z.string().min(1).max(200).optional(),
    })
    const reviewOptions = () => z.strictObject({ eventId: z.string().min(1), verdict: z.enum(['correct', 'wrong', 'unreviewed']) })
    const reportOptions = () => z.strictObject({ format: z.enum(['markdown', 'json']).optional(),
      historyScope: z.enum(['all', 'selected']).optional(), agentId: z.string().min(1).max(200).optional() })
    const configureOptions = () => z.strictObject({ revision: z.string().min(1).max(100),
      skillRoots: z.array(z.string().trim().min(1).max(4096)).max(200),
      mcpServers: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)).max(500) })
    const probeOptions = () => z.strictObject({ query: z.string().trim().min(1).max(1000),
      kind: z.enum(['skill', 'mcp']).optional(), agentId: z.string().min(1).max(200).optional() })
    const methodOptions = { snapshot: snapshotOptions, review: reviewOptions, report: reportOptions, configure: configureOptions, probe: probeOptions }
    const descriptors = Object.keys(methodOptions).map(method => {
      const codec = { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Options`, create: methodOptions[method] }
      return {
        id: `${PACKAGE}#capabilityGateway/${method}`, namespace: 'capabilityGateway',
        service: 'capabilityGateway', method, invocation: { kind: 'direct' },
        parameters: [{ name: 'options', wire: 'options', source: 'json', acceptsUndefined: ['snapshot', 'report'].includes(method), codec, strictCodec: codec }],
        result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, create: () => z.json() },
      }
    })
    async function apply(ctx) {
      const unmount = await ctx.remote.$mount({ package: 'dsh-capability-gateway', descriptors })
      ctx.effect(() => unmount)
      ctx.inject(['remote.capabilityGateway'], uiCtx => {
      const api = Object.fromEntries(Object.keys(methodOptions).map(method => [method, async options => {
        const result = await uiCtx.remote.capabilityGateway[method](options)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value
      }]))
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-capability-gateway'; tag.textContent = style
        document.head.appendChild(tag)
        return () => tag.remove()
      })
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab', id: 'capability-gateway', order: 40,
        label: () => '能力网关', inject: () => ({ api }),
      }, GatewayPanel))
      })
    }
    return { apply, inject: ['slots', 'remote'], GatewayPanel, Inventory, Records, ScopeEditor, SearchLab, Diagnostics, descriptors, style }
  },
})
