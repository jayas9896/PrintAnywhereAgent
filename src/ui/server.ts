import express from 'express'
import type { AgentRuntime } from '../runtime/agentRuntime.js'

function htmlEscape(value: string | null | undefined) {
  return (value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export async function startUiServer(runtime: AgentRuntime) {
  const app = express()
  app.use(express.urlencoded({ extended: false }))

  app.get('/', (_request, response) => {
    const snapshot = runtime.snapshot()
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
      input[type=text], input[type=url] { padding: 10px 12px; border-radius: 10px; border: 1px solid #cad7cf; width: 100%; }
      button { padding: 10px 14px; border: 0; border-radius: 999px; background: #184d31; color: #fff; cursor: pointer; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 10px; border-top: 1px solid #edf2ee; vertical-align: top; }
      .muted { color: #617261; font-size: 14px; }
      .code { font-family: ui-monospace, monospace; letter-spacing: .15em; font-size: 20px; }
      .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    </style>
  </head>
  <body>
    <div class="panel">
      <h1>PrintAnywhere Agent</h1>
      <p class="muted">Local status page for the print-shop owner machine.</p>
    </div>

    <div class="panel">
      <h2>Backend configuration</h2>
      <form method="post" action="/configure">
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
      <div>${htmlEscape(snapshot.registration?.status ?? 'Not registered')}</div>
      <div class="muted" style="margin-top:12px;">Pairing code</div>
      <div class="code">${htmlEscape(snapshot.registration?.pairingCode ?? '—')}</div>
      <div class="muted">Expires: ${htmlEscape(snapshot.registration?.pairingCodeExpiresAt ?? '—')}</div>
      <div class="actions" style="margin-top:14px;">
        <form method="post" action="/actions/repair"><button type="submit">Generate new pairing code</button></form>
        <form method="post" action="/actions/refresh"><button type="submit">Refresh printers now</button></form>
      </div>
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
      <h2>Recent activity</h2>
      <div class="muted">Last heartbeat: ${htmlEscape(snapshot.lastHeartbeatAt ?? 'Never')}</div>
      <div class="muted">Last error: ${htmlEscape(snapshot.lastError ?? 'None')}</div>
      <div class="muted">Last job: ${htmlEscape(snapshot.lastJob ? `${snapshot.lastJob.jobId} · ${snapshot.lastJob.status}` : 'None')}</div>
    </div>
  </body>
</html>`)
  })

  app.post('/configure', async (request, response) => {
    await runtime.configure(String(request.body.serverUrl ?? ''), String(request.body.displayName ?? ''))
    response.redirect('/')
  })

  app.post('/printers/share', async (request, response) => {
    await runtime.setPrinterShared(String(request.body.localPrinterName ?? ''), String(request.body.shared ?? '') === 'true')
    response.redirect('/')
  })

  app.post('/actions/repair', async (_request, response) => {
    await runtime.repairPairingCode()
    response.redirect('/')
  })

  app.post('/actions/refresh', async (_request, response) => {
    await runtime.syncPrinters()
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
