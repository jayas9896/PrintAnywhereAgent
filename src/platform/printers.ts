import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { LocalPrinter } from '../config/types.js'
import { isWindows } from '../core/machine.js'

const execFileAsync = promisify(execFile)

function isVirtualPrinter(name: string) {
  const normalized = name.toLowerCase()
  return normalized.includes('pdf') || normalized.includes('onenote') || normalized.includes('xps')
}

function mockPrinters(sharedPrinters: Record<string, boolean>): LocalPrinter[] {
  return [
    {
      localPrinterName: 'Mock HP LaserJet',
      driverName: 'Mock PCL Driver',
      connectionType: 'USB',
      supportsColor: false,
      supportsDuplex: true,
      supportedPaperSizes: ['A4', 'A5', 'LETTER'],
      isDefault: true,
      status: 'READY',
      shared: sharedPrinters['Mock HP LaserJet'] ?? true,
    },
    {
      localPrinterName: 'Mock Epson WF-C878R',
      driverName: 'Mock Epson Driver',
      connectionType: 'NETWORK',
      supportsColor: true,
      supportsDuplex: true,
      supportedPaperSizes: ['A4', 'A3'],
      isDefault: false,
      status: 'READY',
      shared: sharedPrinters['Mock Epson WF-C878R'] ?? true,
    },
  ]
}

export async function discoverPrinters(sharedPrinters: Record<string, boolean>): Promise<LocalPrinter[]> {
  if (!isWindows()) {
    return mockPrinters(sharedPrinters)
  }

  const scriptPath = fileURLToPath(new URL('../../scripts/discover-printers.ps1', import.meta.url))
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ])
  const printers = JSON.parse(stdout) as Array<{
    localPrinterName: string
    driverName?: string | null
    connectionType: LocalPrinter['connectionType']
    supportsColor: boolean
    supportsDuplex: boolean
    supportedPaperSizes?: string[]
    isDefault: boolean
    status: LocalPrinter['status']
  }>
  return printers.map((printer) => ({
    ...printer,
    supportedPaperSizes: printer.supportedPaperSizes ?? [],
    shared:
      sharedPrinters[printer.localPrinterName] ??
      !isVirtualPrinter(printer.localPrinterName),
  }))
}

export async function printPdf(jobId: string, printerName: string, pdfBuffer: Buffer, simulate = false) {
  if (simulate || !isWindows()) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return
  }

  const { print } = (await import('pdf-to-printer')) as unknown as {
    print: (filePath: string, options: { printer: string }) => Promise<void>
  }
  const tempDir = new URL('../../data/tmp/', import.meta.url)
  await fs.mkdir(tempDir, { recursive: true })
  const tempPath = new URL(`${jobId}.pdf`, tempDir)
  await fs.writeFile(tempPath, pdfBuffer)
  try {
    await print(fileURLToPath(tempPath), { printer: printerName })
  } finally {
    await fs.rm(tempPath, { force: true })
  }
}
