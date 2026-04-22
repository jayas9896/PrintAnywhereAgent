import express from 'express'
import type { Request, Response } from 'express'
import type { AgentRuntime } from '../runtime/agentRuntime.js'

function htmlEscape(value: string | null | undefined) {
  return (value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function hiddenUiToken(uiToken: string | null | undefined) {
  return `<input type="hidden" name="uiToken" value="${htmlEscape(uiToken ?? '')}" />`
}

function isLoopbackOrigin(value: string | undefined) {
  if (!value) return true
  try {
    const url = new URL(value)
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function verifyUiRequest(runtime: AgentRuntime, request: Request, response: Response) {
  const snapshot = runtime.snapshot()
  const uiToken = String(request.body.uiToken ?? '')
  if (!runtime.verifyUiToken(uiToken)) {
    response.status(403).type('text/plain').send('Invalid local UI token')
    return false
  }
  const origin = request.get('origin')
  const referer = request.get('referer')
  if (!isLoopbackOrigin(origin) || !isLoopbackOrigin(referer)) {
    response.status(403).type('text/plain').send('Local UI origin check failed')
    return false
  }
  if (!snapshot.uiToken) {
    response.status(503).type('text/plain').send('Local UI is not initialized')
    return false
  }
  return true
}

export async function startUiServer(runtime: AgentRuntime) {
  const app = express()
  app.use(express.urlencoded({ extended: false }))

  app.get('/', (request, response) => {
    const snapshot = runtime.snapshot()
    const pickupSearch = typeof request.query.pickupCode === 'string' ? request.query.pickupCode.trim().toUpperCase() : ''
    const readyForPickup = (snapshot.readyForPickup ?? []).filter((job) =>
      pickupSearch ? job.pickupCode.toUpperCase().includes(pickupSearch) : true,
    )
    response.type('html').send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>PrintAnywhere Agent</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; background: #f5f7f6; color: #142018; }
      .panel { background: #fff; border: 1px solid #dbe5df; border-radius: 16px; padding: 18px; margin-bottom: 16px; }
      h1, h2 { margin: 0 0 12px; }
      form { display: grid; gap: 12px; }
      input[type=text], input[type=url] { padding: 10px 12px; border-radius: 10px; border: 1px solid #cad7cf; width: 100%; box-sizing: border-box; }
      button { padding: 10px 14px; border: 0; border-radius: 999px; background: #184d31; color: #fff; cursor: pointer; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 10px; border-top: 1px solid #edf2ee; vertical-align: top; }
      .muted { color: #617261; font-size: 14px; }
      .code { font-family: ui-monospace, monospace; letter-spacing: .15em; font-size: 20px; }
      .actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
      .stat { background: #f7faf8; border: 1px solid #e6efea; border-radius: 12px; padding: 12px; }
      .pill { display: inline-block; border-radius: 999px; background: #edf4ef; color: #184d31; padding: 3px 10px; font-size: 12px; }
      .pickup-code { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: .12em; }
      .inline-form { display: inline-flex; gap: 8px; align-items: center; }
    </style>
  </head>
  <body>
    <div class="panel">
      <h1>PrintAnywhere Agent</h1>
      <p class="muted">Local status page for the print-shop owner machine.</p>
      <div class="muted">This UI is protected by a local anti-CSRF token and only accepts loopback-origin form posts.</div>
    </div>

    <div class="panel">
      <h2>Backend configuration</h2>
      <form method="post" action="/configure">
        ${hiddenUiToken(snapshot.uiToken)}
        <label>
          <div class="muted">PrintAnywhere server URL</div>
          <input type="url" name="serverUrl" value="${htmlEscape(snapshot.serverUrl ?? '')}" placeholder="https://print.example.com" required />
        </label>
        <label>
          <div class="muted">Display name</div>
          <input type="text" name="displayName" value="${htmlEscape(snapshot.displayName ?? '')}" placeholder="Counter PC - Front Desk" />
        </label>
        <button type="submit">Save and register</button>
      </form>
    </div>

    <div class="panel">
      <h2>Registration</h2>
      <div class="muted">Machine ID</div>
      <div>${htmlEscape(snapshot.identity?.machineId ?? 'Not initialized')}</div>
      <div class="muted" style="margin-top:12px;">Agent status</div>
      <div><span class="pill">${htmlEscape(snapshot.registration?.status ?? 'Not registered')}</span></div>
      <div class="muted" style="margin-top:12px;">Pairing code</div>
      <div class="code">${htmlEscape(snapshot.registration?.pairingCode ?? '—')}</div>
      <div class="muted">Expires: ${htmlEscape(snapshot.registration?.pairingCodeExpiresAt ?? '—')}</div>
      <div class="actions" style="margin-top:14px;">
        <form method="post" action="/actions/repair">
          ${hiddenUiToken(snapshot.uiToken)}
          <button type="submit">Generate new pairing code</button>
        </form>
        <form method="post" action="/actions/refresh">
          ${hiddenUiToken(snapshot.uiToken)}
          <button type="submit">Refresh printers now</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <h2>Health</h2>
      <div class="stats">
        <div class="stat">
          <div class="muted">Active jobs</div>
          <strong>${snapshot.stats?.activeJobCount ?? 0}</strong>
        </div>
        <div class="stat">
          <div class="muted">Completed today</div>
          <strong>${snapshot.stats?.completedJobsToday ?? 0}</strong>
        </div>
        <div class="stat">
          <div class="muted">Failed today</div>
          <strong>${snapshot.stats?.failedJobsToday ?? 0}</strong>
        </div>
      </div>
      <div class="muted" style="margin-top:12px;">Last heartbeat: ${htmlEscape(snapshot.lastHeartbeatAt ?? 'Never')}</div>
      <div class="muted">Last error: ${htmlEscape(snapshot.lastError ?? 'None')}</div>
      <div class="muted">Last job: ${htmlEscape(snapshot.lastJob ? `${snapshot.lastJob.jobId} · ${snapshot.lastJob.status}` : 'None')}</div>
    </div>

    <div class="panel">
      <h2>Ready for pickup</h2>
      <form method="get" action="/" class="inline-form">
        <label style="flex:1">
          <div class="muted">Search by pickup code</div>
          <input type="text" name="pickupCode" value="${htmlEscape(pickupSearch)}" placeholder="Enter pickup code" />
        </label>
        <button type="submit">Search</button>
      </form>
      <table>
        <thead>
          <tr><th>Pickup code</th><th>Customer</th><th>Printer</th><th>Completed</th><th>Action</th></tr>
        </thead>
        <tbody>
          ${readyForPickup.length === 0 ? `
            <tr><td colspan="5" class="muted">No completed secure pickup jobs are waiting.</td></tr>
          ` : readyForPickup.map((job) => `
            <tr>
              <td><strong class="pickup-code">${htmlEscape(job.pickupCode)}</strong><br/><span class="muted">${htmlEscape(job.jobId)}</span></td>
              <td>${htmlEscape(job.displayName ?? 'Anonymous pickup')}<br/><span class="muted">${htmlEscape(job.pageCount ? `${job.pageCount} pages` : 'Page count unknown')}</span></td>
              <td>${htmlEscape(job.printerName)}</td>
              <td>${htmlEscape(job.completedAt)}</td>
              <td>
                <form method="post" action="/jobs/collect">
                  ${hiddenUiToken(snapshot.uiToken)}
                  <input type="hidden" name="jobId" value="${htmlEscape(job.jobId)}" />
                  <button type="submit">Mark as collected</button>
                </form>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Shared printers</h2>
      <table>
        <thead>
          <tr><th>Printer</th><th>Capabilities</th><th>Share</th></tr>
        </thead>
        <tbody>
          ${snapshot.printers.map((printer) => `
            <tr>
              <td>
                <strong>${htmlEscape(printer.localPrinterName)}</strong><br/>
                <span class="muted">${htmlEscape(printer.driverName ?? 'Unknown driver')} · ${htmlEscape(printer.connectionType)}</span>
              </td>
              <td>
                <span class="muted">
                  ${printer.supportsColor ? 'Color' : 'Mono'} ·
                  ${printer.supportsDuplex ? 'Duplex' : 'Single-sided'} ·
                  ${htmlEscape(printer.supportedPaperSizes.join(', ') || 'Unknown sizes')}
                </span>
              </td>
              <td>
                <form method="post" action="/printers/share">
                  ${hiddenUiToken(snapshot.uiToken)}
                  <input type="hidden" name="localPrinterName" value="${htmlEscape(printer.localPrinterName)}" />
                  <input type="hidden" name="shared" value="${printer.shared ? 'false' : 'true'}" />
                  <button type="submit">${printer.shared ? 'Stop sharing' : 'Share printer'}</button>
                </form>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Recent jobs</h2>
      <table>
        <thead>
          <tr><th>Job</th><th>Printer</th><th>Status</th><th>Details</th></tr>
        </thead>
        <tbody>
          ${(snapshot.recentJobs ?? []).length === 0 ? `
            <tr><td colspan="4" class="muted">No jobs have run yet.</td></tr>
          ` : (snapshot.recentJobs ?? []).map((job) => `
            <tr>
              <td>${htmlEscape(job.jobId)}<br/><span class="muted">${htmlEscape(job.updatedAt)}</span></td>
              <td>${htmlEscape(job.printerName)}</td>
              <td><span class="pill">${htmlEscape(job.status)}</span></td>
              <td>
                ${htmlEscape(job.displayName ?? job.pickupCode ?? '—')}
                ${job.failureReason ? `<br/><span class="muted">${htmlEscape(job.failureReason)}</span>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </body>
</html>`)
  })

  app.post('/configure', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    await runtime.configure(String(request.body.serverUrl ?? ''), String(request.body.displayName ?? ''))
    response.redirect('/')
  })

  app.post('/printers/share', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    await runtime.setPrinterShared(String(request.body.localPrinterName ?? ''), String(request.body.shared ?? '') === 'true')
    response.redirect('/')
  })

  app.post('/actions/repair', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    await runtime.repairPairingCode()
    response.redirect('/')
  })

  app.post('/actions/refresh', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    await runtime.syncPrinters()
    response.redirect('/')
  })

  app.post('/jobs/collect', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    await runtime.markCollected(String(request.body.jobId ?? ''))
    response.redirect('/')
  })

  const port = Number(process.env.PRINTANYWHERE_AGENT_PORT ?? 43100)
  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`PrintAnywhere Agent UI listening on http://127.0.0.1:${port}`)
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()))
          }),
      })
    })
  })
}
