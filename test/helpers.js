/**
 * Shared fixtures for the dsh-fleet unit tests: throwaway Harness homes,
 * profiles, and fake bundle installations.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Create a temp directory removed when the test finishes. */
export function makeTempDir(t, prefix = 'dsh-fleet-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** Write a UTF-8 file, creating parents. */
export function writeTextFile(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** Write pretty JSON with the trailing newline DSH itself uses. */
export function writeJsonFile(path, value) {
  return writeTextFile(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** Write an executable script (marked executable, which spawn needs for shebangs). */
export function writeScript(path, text, mode = 0o755) {
  writeTextFile(path, text)
  chmodSync(path, mode)
  return path
}

/** Create an empty Harness home with a `profiles/` directory. */
export function makeHome(t, prefix = 'fleet-home-') {
  const home = makeTempDir(t, prefix)
  mkdirSync(join(home, 'profiles'), { recursive: true })
  return home
}

/**
 * Write one package into a node_modules directory.
 * `spec.patch` makes it a bundle (`dsh.bundle.patch`); `spec.version` defaults
 * to 1.0.0; `spec.manifest` merges extra package.json fields.
 */
export function writePackage(nodeModulesDir, name, spec = {}) {
  const packageDir = join(nodeModulesDir, name)
  const manifest = {
    name,
    version: spec.version ?? '1.0.0',
    ...(spec.manifest ?? {}),
  }
  if (spec.patch !== undefined) {
    const patchFile = spec.patchFile ?? 'cordis.patch.yml'
    manifest.dsh = { bundle: { patch: patchFile } }
    writeTextFile(join(packageDir, patchFile), spec.patch)
  }
  writeJsonFile(join(packageDir, 'package.json'), manifest)
  return packageDir
}

/**
 * Create a profile under `home`.
 * @param {{ bundles?: string[], dependencies?: Record<string,string>,
 *           patchText?: string, packages?: Record<string, object>,
 *           extraManifest?: object, noManifest?: boolean }} options
 */
export function makeProfile(home, name, options = {}) {
  const dir = join(home, 'profiles', name)
  const {
    bundles = [],
    dependencies = {},
    patchText,
    packages = {},
    extraManifest = {},
    noManifest = false,
  } = options
  if (!noManifest) {
    writeJsonFile(join(dir, 'package.json'), {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies,
      dsh: { profile: { bundles } },
      ...extraManifest,
    })
  }
  if (patchText !== undefined) writeTextFile(join(dir, 'cordis.patch.yml'), patchText)
  for (const [packageName, spec] of Object.entries(packages)) {
    writePackage(join(dir, 'node_modules'), packageName, spec)
  }
  return dir
}

/**
 * Create a fake DSH installation directory usable as `installAnchor`
 * (a package directory whose own `node_modules` carries the bundles).
 */
export function makeInstallation(t, packages = {}) {
  const dir = makeTempDir(t, 'fleet-install-')
  writeJsonFile(join(dir, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.0.0-test' })
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  for (const [packageName, spec] of Object.entries(packages)) {
    writePackage(join(dir, 'node_modules'), packageName, spec)
  }
  return dir
}

/** A valid minimal manifest with the three standard profiles. */
export function baseManifest(overrides = {}) {
  return {
    version: 1,
    profiles: ['web', 'desktop', 'dsh-tui'],
    providers: [],
    bundles: [],
    items: [],
    ...overrides,
  }
}
