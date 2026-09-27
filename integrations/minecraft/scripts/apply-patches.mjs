// Applies patches/*.patch to the matching package in node_modules after `npm install`.
//
// NOTICE:
// In the AIRI monorepo, pnpm applies these through `patchedDependencies` in pnpm-workspace.yaml.
// This module is installed standalone with npm on the helixus branch, and npm has no patch support.
// Removal condition: go back to installing through the pnpm workspace.
//
// `git apply` works as a plain `patch` tool when it cannot find a repository. The package directory is
// inside the AIRI checkout, so GIT_CEILING_DIRECTORIES stops the repository search; otherwise git would
// read the patch paths relative to the repository root and skip every file.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const patchesDir = path.join(root, 'patches')
const tmp = mkdtempSync(path.join(tmpdir(), 'helixus-patches-'))

try {
  for (const file of readdirSync(patchesDir).filter(name => name.endsWith('.patch'))) {
    // `mineflayer-pathfinder.patch` -> package `mineflayer-pathfinder`
    const pkg = file.replace(/\.patch$/, '').replace(/@[\d.]+$/, '')
    const pkgDir = path.join(root, 'node_modules', pkg)
    if (!existsSync(pkgDir)) {
      console.warn(`[patches] ${pkg} is not installed, skipping ${file}`)
      continue
    }

    // Normalize line endings: a Windows checkout may turn the patch into CRLF, the package files are LF.
    const patchPath = path.join(tmp, file)
    writeFileSync(patchPath, readFileSync(path.join(patchesDir, file), 'utf8').replace(/\r\n/g, '\n'))

    const git = args => execFileSync('git', args, {
      cwd: pkgDir,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(pkgDir) },
      stdio: 'pipe',
    })

    try {
      git(['apply', '--reverse', '--check', patchPath])
      console.log(`[patches] ${file} already applied`)
      continue
    }
    catch {}

    git(['apply', patchPath])
    console.log(`[patches] applied ${file}`)
  }
}
finally {
  rmSync(tmp, { recursive: true, force: true })
}
