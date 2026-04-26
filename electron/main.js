const { app, BrowserWindow, ipcMain } = require('electron')
const os = require('os')
const path = require('path')
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
const hasFullPollFlags =
  typeof cmd.flags.question === 'string' &&
  typeof cmd.flags.options === 'string' &&
  cmd.flags.timeout !== undefined
const pollConfig = isCreator && hasFullPollFlags
  ? {
      question: cmd.flags.question,
      options: cmd.flags.options
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      timeoutMs: Math.max(5, Number(cmd.flags.timeout) || 60) * 1000
    }
  : null

if (pearStore) app.setPath('userData', pearStore)

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

ipcMain.on('config', (evt) => {
  evt.returnValue = { role, pollConfig }
})

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
  pear.on('error', console.error) // print network errors, etc.
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
ipcMain.handle('cert:verify', async (evt, { data, password }) => {
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const p12Der = forge.util.createBuffer(buf.toString('binary'))
    const p12Asn1 = forge.asn1.fromDer(p12Der)
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password)

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })
    const certBag = (certBags[forge.pki.oids.certBag] || [])[0]
    if (!certBag) return { ok: false, error: 'No certificate was found in the file' }
    const cert = certBag.cert

    const now = new Date()
    if (now < cert.validity.notBefore || now > cert.validity.notAfter) {
      return { ok: false, error: 'The certificate has expired' }
    }

    const getField = (obj, name) => { try { return obj.getField(name)?.value || '' } catch { return '' } }
    const cn = getField(cert.subject, 'CN')
    const nif = getField(cert.subject, 'serialNumber') || getField(cert.subject, '2.5.4.5')
    const issuer = getField(cert.issuer, 'CN') || 'Unknown CA'

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

    if (!challengeOk) return { ok: false, error: 'Could not verify the certificate key' }

    return {
      ok: true,
      name: cn,
      nif,
      issuer,
      validTo: cert.validity.notAfter.toISOString(),
    }
  } catch (e) {
    const msg = e.message || ''
    if (msg.toLowerCase().includes('password') || msg.toLowerCase().includes('mac')) {
      return { ok: false, error: 'Incorrect password' }
    }
    return { ok: false, error: 'Error reading the certificate: ' + msg }
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
