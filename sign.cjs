// Custom electron-builder signing hook for SSL.com **eSigner cloud** (CodeSignTool).
//
// Active but self-disabling: electron-builder calls this for every artifact
// (simple-ssh.exe, pagent.exe, elevate.exe, the uninstaller, the setup.exe).
// If the ES_* environment variables are not set it skips signing and the build
// succeeds UNSIGNED — so day-to-day `npm run package` keeps working untouched.
//
// To produce a SIGNED build, set these before `npm run package` (see PACKAGING.md
// / .env.example) — no config edit needed:
//   CODESIGNTOOL_PATH = C:\Tools\CodeSignTool\CodeSignTool.bat   (or put on PATH)
//   ES_USERNAME, ES_PASSWORD, ES_CREDENTIAL_ID, ES_TOTP_SECRET
//
// NOTE: this hook is only for the eSigner *cloud* path. A .pfx file (CSC_LINK +
// CSC_KEY_PASSWORD) or a hardware token (win.certificateSubjectName) is signed
// natively by electron-builder and would NOT use this hook (you'd remove the
// `sign: ./sign.cjs` line in electron-builder.yml for those).
//
// Never hard-code credentials here — always pass them via the environment.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Load a local, git-ignored .env (KEY=VALUE per line) if present, without adding
// a dependency. Real environment variables always win over the file.
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env')
  let text
  try {
    text = fs.readFileSync(envPath, 'utf8')
  } catch {
    return // no .env — rely on the ambient environment
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

/** @param {{ path: string }} configuration File electron-builder wants signed. */
exports.default = async function sign(configuration) {
  loadDotEnv()
  const filePath = configuration.path
  const name = path.basename(filePath)

  const { ES_USERNAME, ES_PASSWORD, ES_TOTP_SECRET, ES_CREDENTIAL_ID } = process.env
  if (!ES_USERNAME || !ES_PASSWORD || !ES_TOTP_SECRET) {
    console.log(`[sign] ES_* not set — skipping signing of ${name} (unsigned build)`)
    return
  }

  // CodeSignTool.bat on Windows; allow an explicit override.
  const tool = process.env.CODESIGNTOOL_PATH || 'CodeSignTool.bat'
  const args = [
    'sign',
    `-username=${ES_USERNAME}`,
    `-password=${ES_PASSWORD}`,
    `-totp_secret=${ES_TOTP_SECRET}`,
    `-input_file_path=${filePath}`,
    // sign in place; CodeSignTool otherwise writes to an output dir
    '-override'
  ]
  if (ES_CREDENTIAL_ID) args.push(`-credential_id=${ES_CREDENTIAL_ID}`)

  console.log(`[sign] CodeSignTool signing ${name}`)

  // Modern Node (>=18.20/20.12/21.x) refuses to execFile a .bat/.cmd directly
  // (it throws EINVAL after the BatBadBut fix). Route batch wrappers through
  // cmd.exe with explicit quoting instead of using { shell: true }, whose arg
  // joining would break on the spaces in our paths (e.g. "Simple SSH-...exe").
  const isBatch = /\.(bat|cmd)$/i.test(tool)
  if (isBatch) {
    const quoted = [tool, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ')
    execFileSync('cmd.exe', ['/d', '/s', '/c', quoted], { stdio: 'inherit' })
  } else {
    execFileSync(tool, args, { stdio: 'inherit' })
  }
}
