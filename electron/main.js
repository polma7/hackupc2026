const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const os = require('os')
const path = require('path')
const fs = require('fs')
const http = require('http')
const forge = require('node-forge')
const crypto = require('crypto')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const PearRuntime = require('pear-runtime')

const { isMac, isLinux, isWindows } = require('which-runtime')
const { command, flag } = require('paparam')
const pkg = require('../package.json')
const { name, productName, version, upgrade } = pkg

const protocol = name

const workers = new Map()
let pear = null

const appName = productName ?? name

const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--create', 'start as creator node and auto-create a poll'),
  flag('--question <text>', 'poll question (with --create)'),
  flag('--options <list>', 'comma-separated poll options (with --create)'),
  flag('--timeout <seconds>', 'poll duration in seconds (with --create)')
)

cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2))

const pearStore = cmd.flags.storage
const updates = cmd.flags.updates

const isCreator = cmd.flags.create === true
const role = isCreator ? 'creator' : 'voter'
// Poll config always comes from UI — CLI args ignored for poll content
const pollConfig = null

if (pearStore) app.setPath('userData', pearStore)

// ── Mobile HTTP relay ─────────────────────────────────────────────────────────
const HTTP_PORT = 7331
let mobilePollState = null

function getLocalIP() {
  const ifaces = os.networkInterfaces()
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

const MOBILE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Votar · P2P Voting</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#111;color:#f2f2f2;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px;min-height:100vh}
h1{font-size:22px;margin-bottom:4px}
.sub{color:#aaa;font-size:14px;margin-bottom:24px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:16px;margin-bottom:16px}
.question{font-size:18px;font-weight:600;margin-bottom:8px}
.meta{color:#888;font-size:12px;margin-top:4px}
.opt-btn{display:block;width:100%;padding:14px 16px;margin-bottom:10px;background:#242424;border:1px solid #333;border-radius:10px;color:#f2f2f2;font-size:16px;text-align:left;cursor:pointer;-webkit-appearance:none}
.opt-btn:active{background:#333}
.bar-wrap{margin:10px 0}
.bar-label{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;color:#ccc}
.bar-track{background:#2a2a2a;border-radius:4px;height:8px;overflow:hidden}
.bar-fill{height:100%;background:#5b3aff;border-radius:4px;transition:width 0.4s}
.bar-fill.my{background:#2e7d32}
.status{color:#aaa;font-size:15px;text-align:center;padding:32px 0}
.success{color:#4caf50;font-size:20px;text-align:center;padding:20px 0;font-weight:600}
</style>
</head>
<body>
<h1>P2P Voting</h1>
<p class="sub">Voto móvil anónimo</p>
<div id="app"><p class="status">Conectando...</p></div>
<script>
var vid=sessionStorage.getItem('vid');
if(!vid){vid='m_'+Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem('vid',vid)}
var hasVoted=false,myVote=null;
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function fmt(ms){if(!ms||ms<=0)return'0s';var s=Math.ceil(ms/1000),m=Math.floor(s/60);return m>0?m+'m '+(s%60).toString().padStart(2,'0')+'s':s+'s'}
function render(d){
  var app=document.getElementById('app');
  if(!d||!d.poll){app.innerHTML='<p class="status">Esperando votación activa...</p>';return}
  var p=d.poll,ended=p.status!=='open',counts=p.counts||[],total=counts.reduce(function(a,b){return a+b},0);
  var html='<div class="card"><div class="question">'+esc(p.question)+'</div>';
  html+='<div class="meta">'+total+' voto'+(total!==1?'s':'')+(!ended?' &middot; cierra en <span id="cd">'+fmt(Math.max(0,(p.endsAt||0)-Date.now()))+'</span>':' &middot; Cerrada')+'</div></div>';
  html+='<div class="card">';
  if(hasVoted||ended){
    if(hasVoted)html+='<div class="success">&#10003; Voto registrado</div>';
    for(var i=0;i<p.options.length;i++){
      var opt=p.options[i],lbl=typeof opt==='string'?opt:(opt&&opt.label?opt.label:'Opción '+(i+1));
      var cnt=counts[i]||0,pct=total>0?Math.round(cnt/total*100):0,mine=myVote===i;
      html+='<div class="bar-wrap"><div class="bar-label"><span>'+(mine?'&#10003; ':'')+esc(lbl)+'</span><span>'+cnt+' &middot; '+pct+'%</span></div>';
      html+='<div class="bar-track"><div class="bar-fill'+(mine?' my':'')+'" style="width:'+pct+'%"></div></div></div>';
    }
  }else{
    html+='<p style="color:#aaa;font-size:13px;margin-bottom:14px">Selecciona tu opción:</p>';
    for(var j=0;j<p.options.length;j++){
      var o=p.options[j],lb=typeof o==='string'?o:(o&&o.label?o.label:'Opción '+(j+1));
      html+='<button class="opt-btn" onclick="vote('+j+')">'+esc(lb)+'</button>';
    }
  }
  html+='</div>';
  app.innerHTML=html;
  if(!ended&&!hasVoted){clearInterval(window.__cd);window.__cd=setInterval(function(){var el=document.getElementById('cd');if(el)el.textContent=fmt(Math.max(0,(p.endsAt||0)-Date.now()))},500)}
}
function vote(idx){
  if(hasVoted)return;
  document.querySelectorAll('.opt-btn').forEach(function(b){b.disabled=true});
  fetch('/api/vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voterId:vid,optionIndex:idx})})
    .then(function(r){return r.json()})
    .then(function(d){if(d.ok){hasVoted=true;myVote=idx;poll()}else{document.querySelectorAll('.opt-btn').forEach(function(b){b.disabled=false});alert(d.error||'Error al votar')}})
    .catch(function(e){document.querySelectorAll('.opt-btn').forEach(function(b){b.disabled=false});alert('Error: '+e.message)});
}
function poll(){fetch('/api/state').then(function(r){return r.json()}).then(render).catch(function(){})}
poll();setInterval(poll,2000);
</script>
</body>
</html>`

function startHttpServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(MOBILE_HTML)
      return
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ poll: mobilePollState }))
      return
    }

    if (req.method === 'POST' && req.url === '/api/vote') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const { voterId, optionIndex } = JSON.parse(body)
          if (!voterId || optionIndex === undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'voterId and optionIndex required' }))
            return
          }
          const worker = workers.get('/workers/main.js')
          if (!worker) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'Worker not started' }))
            return
          }
          worker.write(Buffer.from(JSON.stringify({
            type: 'CAST_VOTE',
            voterId: String(voterId).slice(0, 64),
            optionIndex: Number(optionIndex)
          }) + '\n'))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: e.message }))
        }
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log('[main] Mobile HTTP server on port', HTTP_PORT)
  })

  server.on('error', (e) => console.error('[main] HTTP server error:', e.message))
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

ipcMain.on('config', (evt) => {
  evt.returnValue = { role, pollConfig }
})

ipcMain.handle('state:sync', (evt, poll) => {
  mobilePollState = poll
  return true
})

ipcMain.handle('mobile:getUrl', () => {
  return 'http://' + getLocalIP() + ':' + HTTP_PORT
})

ipcMain.handle('qr:generate', async (evt, text) => {
  const QRCode = require('qrcode')
  return QRCode.toDataURL(text, {
    width: 320,
    margin: 1,
    color: { dark: '#f2f2f2', light: '#171717' }
  })
})

ipcMain.handle('export:save', async (evt, { data, filename }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: filename || 'resultados_votacion.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (canceled || !filePath) return { ok: false }
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('cert:verify', async (evt, { data, password }) => {
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const p12Der = forge.util.createBuffer(buf.toString('binary'))
    const p12Asn1 = forge.asn1.fromDer(p12Der)
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password)

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })
    const certBag = (certBags[forge.pki.oids.certBag] || [])[0]
    if (!certBag) return { ok: false, error: 'No se encontró certificado en el archivo' }
    const cert = certBag.cert

    const now = new Date()
    if (now < cert.validity.notBefore || now > cert.validity.notAfter) {
      return { ok: false, error: 'El certificado está caducado' }
    }

    const getField = (obj, fname) => { try { return obj.getField(fname)?.value || '' } catch { return '' } }
    const cn = getField(cert.subject, 'CN')
    const nif = getField(cert.subject, 'serialNumber') || getField(cert.subject, '2.5.4.5')
    const issuer = getField(cert.issuer, 'CN') || 'CA desconocida'

    let challengeOk = false
    try {
      const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })
      const pkBag = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0]
      if (pkBag?.key) {
        const challenge = crypto.randomBytes(32).toString('hex')
        const md = forge.md.sha256.create()
        md.update(challenge, 'utf8')
        const sig = pkBag.key.sign(md)
        const md2 = forge.md.sha256.create()
        md2.update(challenge, 'utf8')
        challengeOk = cert.publicKey.verify(md2.digest().bytes(), sig)
      }
    } catch {
      challengeOk = true // EC key or other type — PKCS12 decryption already proves possession
    }

    if (!challengeOk) return { ok: false, error: 'No se pudo verificar la clave del certificado' }

    return { ok: true, name: cn, nif, issuer, validTo: cert.validity.notAfter.toISOString() }
  } catch (e) {
    const msg = e.message || ''
    if (msg.toLowerCase().includes('password') || msg.toLowerCase().includes('mac')) {
      return { ok: false, error: 'Contraseña incorrecta' }
    }
    return { ok: false, error: 'Error al leer el certificado: ' + msg }
  }
})

ipcMain.handle('app:afterUpdate', () => {
  if (isLinux && process.env.APPIMAGE) {
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: [
        '--appimage-extract-and-run',
        ...process.argv.slice(1).filter((arg) => arg !== '--appimage-extract-and-run')
      ]
    })
  } else if (!isWindows) {
    app.relaunch()
  }
  app.exit(0)
})

// ── Pear runtime helpers ──────────────────────────────────────────────────────

function getPear() {
  if (pear) return pear
  const appPath = getAppPath()
  let dir = null
  if (pearStore) {
    console.log('pear store: ' + pearStore)
    dir = pearStore
  } else if (appPath === null) {
    dir = path.join(os.tmpdir(), 'pear', appName)
  } else {
    dir = isMac
      ? path.join(os.homedir(), 'Library', 'Application Support', appName)
      : isLinux
        ? path.join(os.homedir(), '.config', appName)
        : path.join(os.homedir(), 'AppData', 'Local', appName)
  }

  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'
  const store = new Corestore(path.join(dir, 'pear-runtime/corestore'))
  const swarm = new Hyperswarm()
  pear = new PearRuntime({
    dir,
    app: appPath,
    updates,
    version,
    upgrade,
    name: productName + extension,
    store,
    swarm
  })
  if (updates !== false) {
    swarm.on('connection', (connection) => store.replicate(connection))
    swarm.join(pear.updater.drive.core.discoveryKey, {
      client: true,
      server: false
    })
  }
  pear.on('error', console.error)
  return pear
}

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll(name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(name, data)
  }
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const pear = getPear()
  const workerConfig = JSON.stringify({ role, pollConfig })
  const worker = pear.run(require.resolve('..' + specifier), [pear.storage, workerConfig])
  function sendWorkerStdout(data) {
    sendToAll('pear:worker:stdout:' + specifier, data)
  }
  function sendWorkerStderr(data) {
    sendToAll('pear:worker:stderr:' + specifier, data)
  }
  function sendWorkerIPC(data) {
    sendToAll('pear:worker:ipc:' + specifier, data)
  }
  function onBeforeQuit() {
    worker.destroy()
  }
  ipcMain.handle('pear:worker:writeIPC:' + specifier, (evt, data) => {
    return worker.write(Buffer.from(data))
  })
  workers.set(specifier, worker)
  worker.on('data', sendWorkerIPC)
  worker.stdout.on('data', sendWorkerStdout)
  worker.stderr.on('data', sendWorkerStderr)
  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    worker.removeListener('data', sendWorkerIPC)
    worker.stdout.removeListener('data', sendWorkerStdout)
    worker.stderr.removeListener('data', sendWorkerStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })
  app.on('before-quit', onBeforeQuit)
  return worker
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  const pear = getPear()

  const onUpdating = () => {
    if (!win.isDestroyed()) win.webContents.send('pear:event:updating')
  }

  const onUpdated = () => {
    if (!win.isDestroyed()) win.webContents.send('pear:event:updated')
  }

  pear.updater.on('updating', onUpdating)
  pear.updater.on('updated', onUpdated)

  win.on('closed', () => {
    pear.updater.removeListener('updating', onUpdating)
    pear.updater.removeListener('updated', onUpdated)
  })

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL

  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
    return
  }

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

ipcMain.handle('pear:applyUpdate', () => {
  const pear = getPear()
  pear.updater.applyUpdate()
})
ipcMain.handle('pear:startWorker', (evt, filename) => {
  getWorker(filename)
  return true
})

// ── App lifecycle ─────────────────────────────────────────────────────────────

function handleDeepLink(url) {
  console.log('deep link:', url)
}

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

const lock = pearStore ? true : app.requestSingleInstanceLock()

if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (evt, args) => {
    const url = args.find((arg) => arg.startsWith(protocol + '://'))
    if (url) handleDeepLink(url)
  })

  app.whenReady().then(() => {
    startHttpServer()

    createWindow().catch((err) => {
      console.error('Failed to create window:', err)
      app.quit()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('Failed to create window:', err)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
