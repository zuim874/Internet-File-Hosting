'use strict'
/** 文瀑 · 内网文件中心 —— 前端交互 */

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => document.querySelectorAll(sel)

// 当前浏览状态
const state = {
  path: '',        // 当前目录（服务器内相对路径）
  q: '',           // 搜索关键字
  cat: 'all',      // 分类过滤
  items: [],
  counts: {},
}

// 目录/文件图标映射
const ICON = {
  folder: '▣', video: '▶', audio: '♪', image: '◫', document: '▤',
  archive: '⎍', code: '{ }', other: '·', spreadsheet: '⬒', presentation: '▱',
}

const CAT_LABEL = {
  video: '视频', audio: '音频', image: '图片', document: '文档',
  archive: '压缩包', code: '代码', other: '其他', all: '全部',
  spreadsheet: '表格', presentation: '演示',
}
// 分类顺序（含“全部”）
const CTRL_ORDER = ['all', 'video', 'audio', 'image', 'document', 'archive', 'code', 'other']

/* =============================================================
   数据请求
============================================================= */
function api(path, opts = {}) {
  return fetch(path, opts).then(async (res) => {
    const data = await res.json().catch(() => ({ error: '响应解析失败' }))
    if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`)
    return data
  })
}

function loadList() {
  const params = new URLSearchParams()
  if (state.path) params.set('path', state.path)
  if (state.q) params.set('q', state.q)
  if (state.cat !== 'all') params.set('cat', state.cat)
  showStatus('true') // 保持非空，由 render 隐藏
  return api('/api/list?' + params.toString()).then((data) => {
    state.items = data.items
    state.counts = data.counts
    render(data)
  }).catch((e) => {
    showStatus('加载失败：' + e.message)
  })
}

/* =============================================================
   渲染
============================================================= */
function render(data) {
  renderCrumbs(data)
  renderCats(data)
  renderList(data)
}

function renderCrumbs(data) {
  const wrap = $('#crumbs')
  wrap.innerHTML = ''
  const parts = data.root ? data.root.split('/').filter(Boolean) : []
  // 根
  appendCrumb('全部文件', '', data.root === '' || parts.length === 0)
  let acc = ''
  parts.forEach((p, i) => {
    acc = acc ? acc + '/' + p : p
    if (i === parts.length - 1) {
      wrap.insertAdjacentHTML('beforeend', '<span class="crumb-sep">/</span>')
      appendCrumb(p, acc, true)
    } else {
      wrap.insertAdjacentHTML('beforeend', '<span class="crumb-sep">/</span>')
      const cp = acc
      const el = document.createElement('span')
      el.className = 'crumb'
      el.textContent = p
      el.onclick = () => { state.path = cp; refresh('crumb') }
      wrap.appendChild(el)
    }
  })
  function appendCrumb(text, path, current) {
    const el = document.createElement('span')
    el.className = 'crumb' + (current ? ' current' : '')
    el.textContent = text
    if (!current) el.onclick = () => { state.path = path; refresh('crumb') }
    wrap.appendChild(el)
  }
}

function renderCats(data) {
  const nav = $('#catNav')
  nav.innerHTML = ''
  for (const cat of CTRL_ORDER) {
    const n = cat === 'all'
      ? data.items.length
      : (data.counts[cat] || 0)
    const btn = document.createElement('button')
    btn.className = 'cat' + (state.cat === cat ? ' active' : '')
    btn.innerHTML = `${CAT_LABEL[cat] || cat}<span class="n">${n}</span>`
    btn.onclick = () => { state.cat = cat; refresh('cat') }
    nav.appendChild(btn)
  }
}

function renderList(data) {
  const wrap = $('#fileList')
  const status = $('#status')
  if (!data.items.length) {
    wrap.innerHTML = ''
    status.hidden = false
    status.innerHTML = data.q || data.cat !== 'all'
      ? '<div class="big">∅</div>没有匹配的文件<br><span style="font-size:12px">换个关键词或分类试试</span>'
      : '<div class="big">⟨空⟩</div>这个目录是空的<br><span style="font-size:12px">点击右上角「上传」开始管理文件</span>'
    return
  }
  status.hidden = true
  wrap.innerHTML = ''
  data.items.forEach((f, i) => {
    const el = document.createElement('div')
    el.className = 'frow'
    el.style.setProperty('--d', Math.min(i * 0.03, 0.4) + 's')
    const sub = f.isDir
      ? (f.mtime ? fmtDate(new Date(f.mtime)) : '')
      : `${f.sizeText} · ${fmtDate(new Date(f.mtime))}`
    el.innerHTML = `
      <div class="ico ${f.category}">${ICON[f.category] || '·'}</div>
      <div class="info"><div class="name">${esc(f.name)}</div><div class="meta">${sub}</div></div>
      <span class="tag">${CAT_LABEL[f.category] || f.category}</span>
      <span class="mark">${f.isDir ? '›' : '↵'}</span>`
    el.onclick = () => {
      if (f.isDir) { state.path = joinPath(state.path, f.name); state.cat = 'all'; refresh('nav') }
      else openPreview(f)
    }
    // 行操作：移动 / 删除（文件或文件夹均可），阻止冒泡以免触发行默认行为
    const rowActs = document.createElement('div')
    rowActs.className = 'row-actions'
    const mvBtn = document.createElement('button')
    mvBtn.className = 'act mv'
    mvBtn.innerHTML = '⇄'
    mvBtn.title = f.isDir ? '移动文件夹' : '移动文件'
    mvBtn.onclick = (e) => { e.stopPropagation(); openMove(joinPath(state.path, f.name), f) }
    const delBtn = document.createElement('button')
    delBtn.className = 'act del'
    delBtn.innerHTML = '✕'
    delBtn.title = f.isDir ? '删除文件夹' : '删除文件'
    delBtn.onclick = (e) => {
      e.stopPropagation()
      if (!confirm(`确定删除「${f.name}」${f.isDir ? '及其全部内容' : ''}？此操作不可恢复。`)) return
      const p = encodePath(joinPath(state.path, f.name))
      fetch('/api/delete/' + p, { method: 'DELETE' }).then(r => r.json()).then((d) => {
        if (d.ok) { toast(`已删除「${f.name}」`); loadList() } else toast(d.error || '删除失败', true)
      }).catch(() => toast('删除失败：网络错误', true))
    }
    rowActs.appendChild(mvBtn)
    rowActs.appendChild(delBtn)
    el.appendChild(rowActs)
    wrap.appendChild(el)
  })
}

// 只在分类过滤下进入目录时保留过滤
function joinPath(base, name) { return base ? base + '/' + name : name }

function fmtDate(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function showStatus(msg) {
  const status = $('#status')
  status.hidden = false
  status.innerHTML = msg.startsWith('加载失败')
    ? `<div class="big">⚠</div>${esc(msg)}`
    : `<div class="big">⟨…⟩</div>${esc(msg)}`
}

// refresh 只在最上层导航/刷新使用
function refresh(_from) {
  $('#searchInput').value = state.q
  loadList()
}

/* =============================================================
   搜索
============================================================= */
let searchTimer
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer)
  $('#searchClear').hidden = !e.target.value
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim()
    loadList()
  }, 260)
})
$('#searchClear').onclick = () => {
  $('#searchInput').value = ''
  $('#searchClear').hidden = true
  state.q = ''
  loadList()
}

/* =============================================================
   上传
============================================================= */
const fileInput = $('#fileInput')
$('#uploadTrigger').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files)
  if (files.length) uploadFiles(files, false)
  fileInput.value = ''
})

// 文件夹上传：webkitdirectory 让每个文件携带相对路径 webkitRelativePath
const folderInput = $('#folderInput')
$('#folderUploadTrigger').addEventListener('click', () => folderInput.click())
folderInput.addEventListener('change', () => {
  const files = Array.from(folderInput.files)
  if (files.length) uploadFiles(files, true)
  folderInput.value = ''
})

async function uploadFiles(files, isFolder) {
  const btn = $('#uploadTrigger')
  const card = $('#progressCard')
  const nameEl = $('#progName')
  const pctEl = $('#progPct')
  const barEl = $('#progBar')
  const subEl = $('#progSub')
  btn.classList.add('uploading')
  card.hidden = false
  let done = 0

  // 每个文件依次上传，展示实时进度
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    // 文件夹上传时，保留所选文件夹到该文件的相对目录链（含顶层文件夹），以还原原生结构
    let rel = ''
    if (isFolder) {
      const rp = file.webkitRelativePath || ''
      const idx = rp.lastIndexOf('/')
      if (idx > 0) rel = rp.slice(0, idx)
    }
    nameEl.textContent = rel ? rel + '/' + file.name : file.name
    const q = new URLSearchParams({ path: state.path, name: file.name })
    if (rel) q.set('rel', rel)
    try {
      const ok = await uploadOne(file, q, (p) => {
        const aggregate = (done + p) / files.length
        barEl.style.width = (aggregate * 100).toFixed(1) + '%'
        pctEl.textContent = Math.round(aggregate * 100) + '%'
      })
      if (ok) done++
      else {
        // 失败：显示占比，稍后 toast 提示具体原因
      }
    } catch (e) {
      toast(`‹${file.name}› 上传失败：${e.message}`, true)
    }
  }
  card.hidden = true
  barEl.style.width = '0%'
  btn.classList.remove('uploading')
  toast(`✅ 已上传 ${done}/${files.length} 个文件`)
  loadList()
}

// 基于 XMLHttpRequest 单文件上传，支持上传进度；返回是否成功
function uploadOne(file, q, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', '/api/upload?' + q.toString())
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    // 上传进度事件（fetch 不支持上传进度，故改用 XHR）
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.upload.onload = () => onProgress(1)
    xhr.onload = () => {
      let err = ''
      try { err = JSON.parse(xhr.responseText).error || '' } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(true)
      else { toast(`‹${file.name}› ${err || '上传失败'}`, true); resolve(false) }
    }
    xhr.onerror = () => { toast(`‹${file.name}› 上传失败：网络错误`, true); resolve(false) }
    xhr.onabort = () => { toast(`‹${file.name}› 上传已取消`, true); resolve(false) }
    xhr.send(file)
  })
}

/* =============================================================
   预览 / 下载 / 删除
============================================================= */
const file = (p) => '/api/file/' + encodePath(p)
const download = (p) => '/api/download/' + encodePath(p)

function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/') }

const preview = { name: '', path: '', category: '' }

function openPreview(f) {
  preview.name = f.name
  preview.path = joinPath(state.path, f.name)
  preview.category = f.category
  $('#pvCat').textContent = CAT_LABEL[f.category] || f.category
  $('#pvName').textContent = f.name
  renderPreviewBody()
  $('#pvOpen').hidden = false
  $('#pvDownload').hidden = false
  $('#pvDelete').hidden = false
  openDrawer()
}

function renderPreviewBody() {
  const body = $('#pvBody')
  const ext = preview.name.includes('.') ? preview.name.split('.').pop().toLowerCase() : ''
  const view = categoryView(preview.category, ext)

  if (preview.category === 'video') {
    body.classList.add('center')
    // playsinline/webkit-playsinline：iOS Safari 强制内联播放并允许触摸播放，避免黑屏
    body.innerHTML = `<video class="pv-video" controls preload="metadata" playsinline webkit-playsinline src="${file(preview.path)}"></video>`
  } else if (preview.category === 'audio') {
    body.classList.add('center')
    body.innerHTML = `<audio class="pv-audio" controls preload="metadata" src="${file(preview.path)}"></audio>`
  } else if (preview.category === 'image') {
    body.classList.add('center')
    body.innerHTML = `<img class="pv-img" src="${file(preview.path)}" alt="${esc(preview.name)}" />`
  } else if (preview.category === 'document') {
    body.classList.remove('center')
    if (ext === 'pdf') {
      // 通过缩放视图让长文档在手机端可滚动翻页
      body.innerHTML = `<iframe class="pv-iframe" src="${file(preview.path)}"></iframe>`
    } else if (['md', 'markdown'].includes(ext)) {
      fetch(file(preview.path)).then((r) => r.text()).then(md => {
        body.innerHTML = `<article class="md-body"></article>`
        body.querySelector('.md-body').innerHTML = renderMarkdown(md)
        highlightCode(body.querySelector('.md-body'))
      }).catch(() => { body.innerHTML = `<div class="file-card"><div class="big">⚠</div>无法读取该文件</div>` })
    } else if (['txt', 'log', 'csv'].includes(ext)) {
      fetch(file(preview.path)).then((r) => r.text()).then(t => {
        body.innerHTML = `<pre class="pv-text">${esc(t)}</pre>`
      }).catch(() => { body.innerHTML = `<div class="file-card"><div class="big">⚠</div>无法读取该文件</div>` })
    } else {
      body.classList.add('center')
      body.innerHTML = `<div class="file-card"><div class="big">${view}</div>该类型暂不支持在线预览，请下载查看</div>`
      $('#pvOpen').hide
    }
  } else if (preview.category === 'code') {
    body.classList.remove('center')
    fetch(file(preview.path)).then((r) => r.text()).then(t => {
      body.innerHTML = `<pre class="pv-text">${esc(t)}</pre>`
    }).catch(() => { body.innerHTML = `<div class="file-card"><div class="big">⚠</div>无法读取该文件</div>` })
  } else {
    body.classList.add('center')
    body.innerHTML = `<div class="file-card"><div class="big">${view}</div>该类型暂无在线预览，点击「下载」查看</div>`
  }
}

function categoryView(cat, ext) {
  if (ext === 'pdf') return '▤'
  const map = { video: '▶', audio: '♪', image: '◫', document: '▤', archive: '⎍', code: '{ }', other: '·' }
  return map[cat] || '·'
}

// 极简 Markdown 渲染（满足常见语法）
function renderMarkdown(md) {
  let html = esc(md)
  // 代码块（先保护，避免内部被后续规则破坏）
  const blocks = []
  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push('<pre><code>' + code.trim() + '</code></pre>')
    return '␀B' + (blocks.length - 1) + '␀'
  })
  // 链接与图片
  html = html.replace(/!\[([^\]]*)\]\(\s*(https?:[^)\s]+)\s*\)/g, '<img src="$2" alt="$1" />')
  html = html.replace(/\[([^\]]+)\]\(\s*(https?:[^)\s]+)\s*\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  // 行内
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  // 水平线
  html = html.replace(/^---+$/gm, '<hr />')
  // 标题
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
    .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
    .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
  // 引用
  html = html.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>')
  // 表格
  html = html.replace(/((?:^[^\n]*\|[^\n]*$\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => r.includes('|'))
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    if (!rows.length) return block
    const [h, sep, ...body] = rows.map(cells)
    if (!sep || !/^[:\-\s]+$/.test(sep.join(' ') || '')) return block
    const thead = '<thead><tr>' + h.map(c => '<th>' + c + '</th>').join('') + '</tr></thead>'
    const tbody = '<tbody>' + body.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody>'
    return '<table>' + thead + tbody + '</table>'
  })
  // 列表
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, (m) => '<ul>' + m.replace(/<\/li>\s*<li>/g, '</li><li>') + '</ul>')
  // 段落：按空行分组，非块级行包成 <p>
  html = html.split(/\n{2,}/).map((chunk) => {
    chunk = chunk.trim()
    if (!chunk) return ''
    if (/^<(h[1-6]|ul|ol|pre|blockquote|table|hr|p)(\s|>)/.test(chunk)) return chunk
    return '<p>' + chunk.replace(/\n/g, '<br>') + '</p>'
  }).join('\n')
  // 还原代码块
  html = html.replace(/␀B(\d+)␀/g, (_, i) => blocks[+i])
  return html
}

// 代码块高亮（极简关键字着色）
function highlightCode(root) {
  root.querySelectorAll('pre code').forEach((el) => {
    const lang = (el.className.match(/lang-(\w+)/) || [])[1]
    let code = el.textContent
    code = code.replace(/(\/\/[^\n]+)/g, '<span style="color:#5d6a92">$1</span>')
      .replace(/("[^"]*"|'[^']*')/g, '<span style="color:#6ee7c4">$1</span>')
    if (['js','ts','java','go','rust','c','cpp'].includes(lang)) {
      code = code.replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|new|typeof|async|await)\b/g, '<span style="color:#f2b04a">$1</span>')
    }
    el.innerHTML = code
  })
}

// 下载
$('#pvDownload').onclick = () => {
  const a = document.createElement('a')
  a.href = download(preview.path)
  a.download = preview.name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
// 新窗口打开
$('#pvOpen').onclick = () => window.open(file(preview.path), '_blank')
// 删除
$('#pvDelete').onclick = () => {
  if (!confirm(`确定删除「${preview.name}」？此操作不可恢复。`)) return
  fetch('/api/delete/' + encodePath(preview.path), { method: 'DELETE' })
    .then(r => r.json())
    .then(d => {
      if (d.ok) { toast('已删除'); closeDrawer(); loadList() }
      else toast(d.error || '删除失败', true)
    })
    .catch(e => toast('删除失败：' + e.message, true))
}

/* =============================================================
   抽屉开关
============================================================= */
function openDrawer() {
  $('#previewScrim').hidden = false
  $('#previewDrawer').hidden = false
  requestAnimationFrame(() => $('#previewDrawer').classList.add('open'))
}
function closeDrawer() {
  $('#previewDrawer').classList.remove('open')
  setTimeout(() => { $('#previewDrawer').hidden = true; $('#previewScrim').hidden = true }, 300)
  $('#pvBody').innerHTML = ''
}
$('#pvClose').onclick = closeDrawer
$('#previewScrim').onclick = closeDrawer
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer() })

/* =============================================================
   移动文件/文件夹
============================================================= */
const mvScrim = $('#mvScrim')
const mvState = { source: '', name: '', isDir: false, pick: '' }
function closeMove() { mvScrim.hidden = true }

function openMove(srcRel, f) {
  mvState.source = srcRel
  mvState.name = f.name
  mvState.isDir = f.isDir
  // 初始定位到源所在目录（上一级），便于直接看到平级目录
  const sl = srcRel.lastIndexOf('/')
  mvState.pick = sl >= 0 ? srcRel.slice(0, sl) : ''
  $('#mvTitle').textContent = f.isDir ? '移动文件夹' : '移动文件'
  $('#mvSource').textContent = `来源：${srcRel || '根目录'}`
  mvScrim.hidden = false
  renderMv()
}

function renderMv() {
  const box = $('#mvBox')
  const crumbs = $('#mvCrumbs')
  const okBtn = $('#mvOk')
  // 面包屑：逐级可跳回
  crumbs.innerHTML = ''
  const parts = mvState.pick ? mvState.pick.split('/').filter(Boolean) : []
  let acc = ''
  crumbs.appendChild(makeCrumb('根目录', '', mvState.pick === ''))
  parts.forEach((p, i) => {
    acc = acc ? acc + '/' + p : p
    crumbs.appendChild(makeCrumb(p, acc, i === parts.length - 1))
  })
  function makeCrumb(text, val, current) {
    const s = document.createElement('span')
    s.className = 'mvc' + (current ? ' cur' : '')
    s.textContent = text
    if (!current) s.onclick = () => { mvState.pick = val === '' ? '' : val; renderMv() }
    return s
  }
  // 上一级按钮
  $('#mvUp').style.visibility = mvState.pick ? 'visible' : 'hidden'
  $('#mvUp').onclick = () => {
    if (!mvState.pick) return
    mvState.pick = parentPath(mvState.pick)
    renderMv()
  }
  // 目标子目录列表
  box.innerHTML = '<div class="mv-loading">加载中…</div>'
  const q = mvState.pick ? '?path=' + encodeURIComponent(mvState.pick) : ''
  api('/api/list' + q).then((data) => {
    const dirs = data.items.filter(i => i.isDir)
    box.innerHTML = ''
    if (!dirs.length) {
      box.innerHTML = '<div class="mv-empty">当前目录没有子文件夹</div>'
    } else {
      dirs.forEach((d) => {
        const cell = document.createElement('div')
        cell.className = 'mv-folder'
        cell.innerHTML = `<span class="mv-fico">▣</span><span class="mv-fname">${esc(d.name)}</span>`
        cell.onclick = () => { mvState.pick = joinPath(mvState.pick, d.name); renderMv() }
        box.appendChild(cell)
      })
    }
    updateMvOk()
  }).catch(() => {
    box.innerHTML = '<div class="mv-empty">加载失败</div>'
  })

  // 移动到此处按钮可用性
  function updateMvOk() {
    const srcParent = parentPath(mvState.source)
    const bad = mvState.pick === srcParent            // 原位
      || mvState.pick === mvState.source              // 自己
      || (mvState.isDir && (mvState.pick === mvState.source || mvState.pick.startsWith(mvState.source + '/')))
    okBtn.disabled = !!bad
    okBtn.textContent = '移动到此处'
  }
}
function parentPath(p) {
  if (!p) return ''
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function doMove() {
  const okBtn = $('#mvOk')
  okBtn.disabled = true
  api('/api/move?' + new URLSearchParams({ from: mvState.source, to: mvState.pick }).toString(), { method: 'POST' })
    .then(() => {
      closeMove()
      toast(`✅ 已移动「${mvState.name}」`)
      loadList()
    })
    .catch((e) => { toast('移动失败：' + e.message, true); renderMv() })
}
$('#mvOk').onclick = doMove
$('#mvCancel').onclick = closeMove
mvScrim.addEventListener('click', (e) => { if (e.target === mvScrim) closeMove() })

/* =============================================================
   新建文件夹
============================================================= */
const mkdirScrim = $('#mkdirScrim')
const mkdirName = $('#mkdirName')
function closeMkdir() { mkdirScrim.hidden = true }
function doMkdir() {
  const name = mkdirName.value.trim()
  if (!name) { mkdirName.focus(); return }
  api('/api/mkdir?' + new URLSearchParams({ path: state.path, name }).toString(), { method: 'POST' })
    .then(() => { closeMkdir(); toast(`✅ 已创建文件夹「${name}」`); loadList() })
    .catch((e) => toast('创建失败：' + e.message, true))
}
$('#mkdirTrigger').addEventListener('click', () => {
  $('#mkdirSub').textContent = state.path ? `将创建在：${state.path}` : '将创建在当前根目录'
  mkdirName.value = ''
  mkdirScrim.hidden = false
  setTimeout(() => mkdirName.focus(), 30)
})
$('#mkdirCancel').onclick = closeMkdir
$('#mkdirOk').onclick = doMkdir
mkdirScrim.addEventListener('click', (e) => { if (e.target === mkdirScrim) closeMkdir() })
mkdirName.addEventListener('keydown', (e) => { if (e.key === 'Enter') doMkdir() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mkdirScrim.hidden) closeMkdir() })

/* =============================================================
   Toast 提示
============================================================= */
function toast(msg, isErr = false, persist = false) {
  const wrap = $('#toastWrap')
  const el = document.createElement('div')
  el.className = 'toast' + (isErr ? ' err' : '')
  el.innerHTML = `<span class="bar"></span>${esc(msg)}`
  wrap.appendChild(el)
  if (!persist) {
    setTimeout(() => {
      el.classList.add('fading')
      setTimeout(() => el.remove(), 500)
    }, 2600)
  } else {
    // 替换旧的持久化 toast，避免堆积
    wrap.querySelectorAll('.toast').forEach(prev => { if (prev !== el) { prev.classList.add('fading'); setTimeout(() => prev.remove(), 400) } })
  }
}

/* =============================================================
   初始化
============================================================= */
function init() {
  // 服务信息
  $('#serverInfo').textContent = location.hostname + ':' + location.port
  loadList()
}
init()