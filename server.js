'use strict'
/**
 * 内网文件托管服务 —— 无第三方依赖，基于 Node 原生 http 实现
 *
 * 能力：
 *  - GET  /api/list?path=&q=&cat=   文件/目录列表（支持搜索、分类过滤）
 *  - PUT  /api/upload?path=&name=  原始字节流上传文件
 *  - GET  /api/file/path/to.ext    预览&下载，支持 Range 分段（视频可拖动进度）
 *  - DELETE /api/file/path/to.ext  删除文件
 *  - GET  /api/up?path=            获取父级路径
 *  - 其余静态资源优先从 public/ 目录读取
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---------------------------------------------------------------------------
// 配置加载：优先取已有的环境变量（如批处理传入），其次读取项目根目录的 .env 文件
// ---------------------------------------------------------------------------

/**
 * 加载项目根目录下 .env 文件到 process.env
 * 仅当该变量当前未被占用时写入，保证外部环境变量优先级更高
 */
function loadEnvFile(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    // 跳过空行与注释
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (!key) continue
    // 去掉首尾的成对引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}
loadEnvFile()

const PORT = Number(process.env.PORT || 8080)
const ROOT = path.resolve(process.env.FILE_ROOT || path.join(os.homedir(), 'FileHost'))
const PUBLIC_DIR = path.join(__dirname, 'public')

// MIME 类型表（按扩展名）
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

// 分类 → 扩展名映射（用于前端分类统计与过滤）
const CATEGORY = {
  video: ['.mp4', '.webm', '.mov', '.mkv', '.m4v'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.flac'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'],
  document: ['.pdf', '.md', '.markdown', '.txt', '.doc', '.docx', '.ppt', '.pptx', '.csv', '.log'],
  archive: ['.zip', '.gz', '.tar', '.7z', '.rar'],
  code: ['.js', '.mjs', '.html', '.htm', '.css', '.json', '.xml', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.sh'],
  presentation: ['.ppt', '.pptx', '.key'],
  spreadsheet: ['.xls', '.xlsx'],
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 将 URL 中的相对路径安全解析为 ROOT 下的绝对路径，防止目录穿越 */
function safeResolve(rel) {
  const joined = path.join(ROOT, rel || '')
  if (joined !== ROOT && !joined.startsWith(ROOT + path.sep)) {
    throw new Error('Forbidden')
  }
  return joined
}

/** 获取文件所属分类 */
function categoryOf(name) {
  const ext = path.extname(name).toLowerCase()
  for (const [cat, exts] of Object.entries(CATEGORY)) {
    if (exts.includes(ext)) return cat
  }
  return 'other'
}

/** 格式化文件大小 */
function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i]
}

/** 是否可在线预览 */
function previewable(name) {
  const ext = path.extname(name).toLowerCase()
  return (MIME[ext] || '').startsWith('text/')
    || ['video', 'audio', 'image', 'document'].includes(categoryOf(name))
}

/** 返回 JSON */
function sendJSON(res, code, obj) {
  const data = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(data)
}

/** 返回错误 */
function sendError(res, code, msg) {
  sendJSON(res, code, { error: msg })
}

/** 递归清理托管目录内遗留的临时上传文件（*.part），启动时调用一次 */
function sweepParts(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      sweepParts(full)
    } else if (ent.name.endsWith('.part')) {
      try { fs.unlinkSync(full); console.log(`  已清理残留临时文件: ${full}`) } catch (_) {}
    }
  }
}

/** 解析 query string */
function parseQuery(url) {
  const q = url.split('?')[1]
  const out = {}
  if (q) {
    for (const pair of q.split('&')) {
      if (!pair) continue
      const [k, v] = pair.split('=')
      out[decodeURIComponent(k)] = decodeURIComponent(v || '')
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------

/** 文件/目录列表 */
function handleList(res, query) {
  // 表达式校验
  if (!/^[^?&#*/\\:]*$/.test(query.q || '')) {
    return sendError(res, 400, '搜索关键字不合法')
  }
  let abs
  try {
    abs = safeResolve(query.path || '')
  } catch (e) {
    return sendError(res, 403, '路径禁止访问')
  }
  if (!fs.existsSync(abs)) return sendError(res, 404, '路径不存在')

  const isDir = fs.statSync(abs).isDirectory()
  const all = isDir
    ? fs.readdirSync(abs, { withFileTypes: true })
        .map(d => {
          const full = path.join(abs, d.name)
          let size = null
          let mtime = null
          if (d.isDirectory()) {
            mtime = fs.statSync(full).mtime
          } else {
            const s = fs.statSync(full)
            size = s.size
            mtime = s.mtime
          }
          return {
            name: d.name,
            isDir: d.isDirectory(),
            size,
            sizeText: d.isDirectory() ? '' : humanSize(size),
            mtime: mtime ? mtime.toISOString() : null,
            category: d.isDirectory() ? 'folder' : categoryOf(d.name),
            preview: d.isDirectory() ? false : previewable(d.name),
          }
        })
        .filter(f => !f.name.startsWith('.')) // 隐藏点文件
    : []

  // 分类过滤
  const cat = query.cat || 'all'
  let items = all
  if (cat !== 'all') {
    items = items.filter(f => f.category === cat || f.isDir)
  }
  // 搜索过滤（命中目录名或文件名）
  const q = (query.q || '').trim().toLowerCase()
  if (q) {
    items = items.filter(f => f.name.toLowerCase().includes(q))
  }
  // 排序：目录优先，再按名称
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })

  // 统计每个分类的文件数量
  const counts = {}
  for (const f of all) {
    if (f.isDir) continue
    counts[f.category] = (counts[f.category] || 0) + 1
  }

  sendJSON(res, 200, {
    root: query.path || '',
    parent: query.path ? path.posix.dirname(query.path) : null,
    isRoot: !query.path,
    items,
    counts,
    total: items.length,
  })
}

/** 上传文件：PUT /api/upload?path=&name=  请求体为原始字节 */
/**
 * 先写入同目录下的临时文件，全部接收完成后原子重命名为最终文件名。
 * 传输一旦中断/出错，立即删除临时文件并回滚——不会留下残缺的“异常文件”，
 * 也不会破坏磁盘上已有的同名好文件。
 */
function handleUpload(req, res, query) {
  const name = (query.name || '').trim()
  if (!name || /[\\/]/.test(name)) return sendError(res, 400, '文件名不合法')
  let dir
  try {
    dir = safeResolve(query.path || '')
  } catch (e) {
    return sendError(res, 403, '路径禁止访问')
  }
  if (!fs.existsSync(dir)) return sendError(res, 404, '目录不存在')
  if (!fs.statSync(dir).isDirectory()) return sendError(res, 400, '目标不是目录')

  // 可选 rel：目标目录下的相对子目录链（以 / 分隔），用于文件夹上传保持原生目录结构。
  // 逐段校验，拒绝分隔符、Windows 非法字符以及 . / .. 路径穿越。
  let relDir = ''
  if (query.rel) {
    const parts = query.rel.split('/').filter(Boolean)
    if (parts.some(p => /[\\/:*?"<>|]|^\.\.?$/.test(p))) {
      return sendError(res, 403, '相对路径不合法')
    }
    relDir = path.join(...parts)
  }
  const baseDir = path.join(dir, relDir)
  if (relDir) {
    // 逐级创建子目录；递归创建不会越出安全解析后的 baseDir
    try { fs.mkdirSync(baseDir, { recursive: true }) } catch (e) {
      return sendError(res, 500, '创建子目录失败')
    }
  }

  const finalPath = path.join(baseDir, name)
  const tmpPath = finalPath + '.part'
  let bytes = 0
  let finished = false
  let responded = false

  const respondOnce = (code, obj) => {
    if (responded) return
    responded = true
    sendJSON(res, code, obj)
  }
  // 回滚：删除未完成的临时文件（仅在尚未完成传输时执行）
  const rollback = () => {
    if (finished) return
    fs.unlink(tmpPath, () => {})
  }

  const ws = fs.createWriteStream(tmpPath, { flags: 'w' })
  req.on('error', () => { ws.destroy(); rollback() })
  // 客户端中断（如浏览器取消、断网）
  req.on('aborted', () => { ws.destroy(); rollback() })
  // 请求体关闭且未正常结束时兜底清理（覆盖不触发 aborted 的情况）
  // 注意：请求体完整接收时 req.complete 为 true，此时属正常结束，
  // 切勿销毁仍在落盘的流，否则会触发 "Cannot call write after a stream was destroyed"。
  req.on('close', () => {
    if (req.complete) return
    if (!finished) { ws.destroy(); rollback() }
  })

  ws.on('error', (e) => {
    rollback()
    // 透传底层原因（权限/目录不存在/磁盘满等），便于定位
    respondOnce(500, { error: '写入失败: ' + ((e && e.message) || '未知原因') })
  })
  ws.on('finish', () => {
    finished = true
    // 原子重命名：覆盖旧文件或落盘新文件，成功前不暴露最终文件名
    fs.rename(tmpPath, finalPath, (err) => {
      if (err) {
        fs.unlink(tmpPath, () => {})
        respondOnce(500, { error: '保存失败' })
        return
      }
      respondOnce(200, { ok: true, size: bytes, sizeText: humanSize(bytes) })
    })
  })
  req.pipe(ws)
}

/** 读取文件（支持 Range）：GET /api/file/{path} */
function handleFile(req, res, urlPath) {
  let abs
  try {
    abs = safeResolve(urlPath)
  } catch (e) {
    return sendError(res, 403, '路径禁止访问')
  }
  if (!fs.existsSync(abs)) return sendError(res, 404, '文件不存在')
  if (fs.statSync(abs).isDirectory()) return sendError(res, 400, '这是目录')

  const stat = fs.statSync(abs)
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream'
  const range = req.headers.range
  const full = abs

  if (!range) {
    // 无 Range：返回整个文件，并允许内联预览
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Last-Modified': stat.mtime.toUTCString(),
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(full).pipe(res)
    return
  }

  // 解析 Range: bytes=start-end
  const m = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!m) return res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end()
  let start = m[1] ? parseInt(m[1], 10) : 0
  let end = m[2] ? parseInt(m[2], 10) : stat.size - 1
  if (start >= stat.size) {
    return res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end()
  }
  end = Math.min(end, stat.size - 1)
  const length = end - start + 1
  res.writeHead(206, {
    'Content-Type': mime,
    'Content-Length': length,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(full, { start, end }).pipe(res)
}

/** 下载（强制附件）：GET /api/download/{path} */
function handleDownload(req, res, urlPath) {
  let abs
  try {
    abs = safeResolve(urlPath)
  } catch (e) {
    return sendError(res, 403, '路径禁止访问')
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return sendError(res, 404, '文件不存在')
  }
  const stat = fs.statSync(abs)
  const name = encodeURIComponent(path.basename(abs))
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    'Accept-Ranges': 'bytes',
  })
  fs.createReadStream(abs).pipe(res)
}

/** 删除文件/目录：DELETE /api/file/{path} */
function handleDelete(req, res, urlPath) {
  let abs
  try {
    abs = safeResolve(urlPath)
  } catch (e) {
    return sendError(res, 403, '路径禁止访问')
  }
  if (abs === ROOT) return sendError(res, 400, '不能删除根目录')
  if (!fs.existsSync(abs)) return sendError(res, 404, '不存在')
  try {
    fs.rmSync(abs, { recursive: true, force: true })
    sendJSON(res, 200, { ok: true })
  } catch (e) {
    sendError(res, 500, '删除失败')
  }
}

/** 新建目录：POST /api/mkdir?path=&name= */
function handleMkdir(res, query) {
  const name = (query.name || '').trim()
  // 目录名禁止包含路径分隔符与 Windows 非法字符
  if (!name || /[\\/:*?"<>|]/.test(name)) return sendError(res, 400, '目录名不合法')
  let parent
  try {
    parent = safeResolve(query.path || '')
  } catch (e) {
    return sendError(res, 403, '路径禁止访问')
  }
  if (!fs.existsSync(parent)) return sendError(res, 404, '目录不存在')
  if (!fs.statSync(parent).isDirectory()) return sendError(res, 400, '目标不是目录')
  const target = path.join(parent, name)
  if (fs.existsSync(target)) return sendError(res, 409, '同名文件或目录已存在')
  try {
    fs.mkdirSync(target)
    sendJSON(res, 200, { ok: true })
  } catch (e) {
    sendError(res, 500, '创建失败')
  }
}

/** 移动文件/目录到目标目录：POST /api/move?from=&to=
 *  from / to 均指服务器内相对路径；to 为目标目录，原文件保留原文件名移入其中 */
function handleMove(res, query) {
  const from = (query.from || '').trim()
  const to = (query.to || '').trim()
  if (!from) return sendError(res, 400, '缺少源路径')
  let fromAbs, toAbs
  try {
    fromAbs = safeResolve(from)
  } catch (e) {
    return sendError(res, 403, '源路径禁止访问')
  }
  try {
    toAbs = safeResolve(to || '')
  } catch (e) {
    return sendError(res, 403, '目标路径禁止访问')
  }
  if (!fs.existsSync(fromAbs)) return sendError(res, 404, '源路径不存在')
  if (!fs.existsSync(toAbs) || !fs.statSync(toAbs).isDirectory()) return sendError(res, 400, '目标不是目录')
  if (fromAbs === ROOT) return sendError(res, 400, '不能移动根目录')
  // 禁止把目录移入自身或其子目录
  if (fs.statSync(fromAbs).isDirectory() && (toAbs === fromAbs || toAbs.startsWith(fromAbs + path.sep))) {
    return sendError(res, 400, '不能移动到自身或其子目录')
  }
  const target = path.join(toAbs, path.basename(fromAbs))
  if (target === fromAbs) return sendError(res, 400, '文件已位于该目录')
  if (fs.existsSync(target)) return sendError(res, 409, '目标目录已有同名文件')
  try {
    fs.renameSync(fromAbs, target)
    sendJSON(res, 200, { ok: true })
  } catch (e) {
    sendError(res, 500, '移动失败')
  }
}

// ---------------------------------------------------------------------------
// 主服务器
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  const query = parseQuery(req.url)

  if (url === '/api/list') return handleList(res, query)
  if (url === '/api/mkdir' && req.method === 'POST') return handleMkdir(res, query)
  if (url === '/api/move' && req.method === 'POST') return handleMove(res, query)
  if (url.startsWith('/api/upload')) return handleUpload(req, res, query)

  if (url.startsWith('/api/file/')) {
    const p = decodeURIComponent(url.slice('/api/file/'.length))
    return handleFile(req, res, p)
  }
  if (url.startsWith('/api/download/')) {
    const p = decodeURIComponent(url.slice('/api/download/'.length))
    return handleDownload(req, res, p)
  }
  if (url.startsWith('/api/delete/') && req.method === 'DELETE') {
    const p = decodeURIComponent(url.slice('/api/delete/'.length))
    return handleDelete(req, res, p)
  }

  // 静态资源：public/ 目录
  let staticPath = url === '/' ? 'index.html' : url.slice(1)
  const abs = path.join(PUBLIC_DIR, staticPath)
  if (!abs.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'Forbidden')
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' })
    return fs.createReadStream(abs).pipe(res)
  }
  // 其他 404
  sendError(res, 404, 'Not Found')
})

// 确保根目录存在
if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true })
// 清理此前中断上传遗留的临时文件（*.part）
sweepParts(ROOT)
// 启动自检：托管根目录是否可写（不可写会在 bat 窗口明确提示）
const rootWriteable = (() => {
  const probe = path.join(ROOT, '.write-probe-' + Date.now())
  try {
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch (e) {
    return false
  }
})()

server.listen(PORT, () => {
  console.log('======================================================')
  console.log('  内网文件托管服务已启动')
  console.log(`  访问地址 : http://localhost:${PORT}`)
  console.log(`  内网地址 : http://${lanIP()}:${PORT}`)
  console.log(`  文件目录 : ${ROOT}`)
  if (!rootWriteable) {
    console.log('  [警告] 文件目录不可写！上传将失败。')
    console.log('  请检查该目录的写入权限，或在 .env 中更换 FILE_ROOT。')
  }
  console.log('======================================================')
})

/** 获取局域网 IP（用于提示内网访问地址） */
function lanIP() {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}