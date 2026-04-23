import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const config: ForgeConfig = {
  packagerConfig: {
    icon: './assets/icon',
    asar: {
      unpack: '**/node_modules/{node-pty,ssh2}/**',
    },
    // The tether-helm MCP server ships outside the asar so Claude Code can
    // spawn it as a subprocess via `node <path>/dist/index.js`. Kept as a
    // plain directory (not pkg'd into a single .exe) for now — assumes the
    // user has `node` on PATH. If/when we need a fully-standalone build,
    // switch to @yao-pkg/pkg and replace this with the compiled binary.
    extraResource: ['mcp-servers/tether-helm'],
  },
  rebuildConfig: {
    // Skip native module rebuild during dev — prebuilt N-API binaries work.
    // VS 2025 (v18) is not yet recognized by @electron/node-gyp.
    onlyModules: [],
  },
  hooks: {
    // Ensure the tether-helm MCP server is built (and its node_modules are
    // installed) BEFORE packagerConfig.extraResource tries to copy them into
    // the packaged app. Forge's own build pipeline doesn't know about this
    // subpackage, so we drive it here.
    //
    // We resolve `npm-cli.js` from the running Node's install tree and drive
    // it via `spawnSync(process.execPath, [npmCli, ...])` rather than shelling
    // out through `$PATH`. Sidesteps the "PATH entry could replace npm"
    // hardening rule and guarantees the npm that matches the Node we're
    // already running.
    prePackage: async () => {
      const helmDir = path.resolve(__dirname, 'mcp-servers', 'tether-helm');

      const nodeDir = path.dirname(process.execPath);
      const npmCandidates = [
        // Windows installer + some Unix layouts: npm sits next to node.exe.
        path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        // Standard Unix: /usr/bin/node -> /usr/lib/node_modules/npm/...
        path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ];
      const npmCli = npmCandidates.find(p => fs.existsSync(p));
      if (!npmCli) {
        throw new Error(`Could not locate npm-cli.js relative to ${process.execPath}`);
      }

      const runNpm = (args: string[]): void => {
        const result = spawnSync(process.execPath, [npmCli, ...args], {
          cwd: helmDir,
          stdio: 'inherit',
        });
        if (result.status !== 0) {
          throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`);
        }
      };

      if (!fs.existsSync(path.join(helmDir, 'node_modules'))) {
        runNpm(['install', '--no-audit', '--no-fund']);
      }
      runNpm(['run', 'build']);
    },
    // Copy externalized node_modules (and their full transitive dep graphs)
    // into the packaged app before ASAR creation. Vite externalizes node-pty
    // and ssh2 (see vite.main.config.ts) so they aren't bundled — without
    // this hook they'd be missing from the asar entirely. We walk each
    // module's package.json recursively so adding/removing transitive deps
    // upstream doesn't silently break the build (e.g. ssh2 -> asn1 ->
    // safer-buffer was missed by the previous hardcoded list, breaking SSH
    // sessions in v0.1.3).
    packageAfterCopy: async (_config, buildPath) => {
      const nodeModulesPath = path.join(buildPath, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        fs.mkdirSync(nodeModulesPath, { recursive: true });
      }

      const externalModules = ['node-pty', 'ssh2'];
      const srcModules = path.resolve(__dirname, 'node_modules');

      // Recursively collect a module + every dep listed in its package.json
      // (dependencies and optionalDependencies). Assumes a flat node_modules
      // layout, which is what npm 7+ produces for this project.
      const collect = (name: string, seen: Set<string>): void => {
        if (seen.has(name)) return;
        const pkgPath = path.join(srcModules, name, 'package.json');
        if (!fs.existsSync(pkgPath)) return;
        seen.add(name);
        let pkg: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
        try {
          pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        } catch {
          return;
        }
        const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
        for (const dep of Object.keys(deps)) collect(dep, seen);
      };

      const toCopy = new Set<string>();
      for (const mod of externalModules) collect(mod, toCopy);

      for (const mod of toCopy) {
        const src = path.join(srcModules, mod);
        const dest = path.join(nodeModulesPath, mod);
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      }
    },
  },
  makers: [
    new MakerSquirrel({ setupIcon: './assets/icon.ico' }),
    new MakerZIP({}, ['darwin', 'win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/preload/docs-preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
        {
          name: 'docs_window',
          config: 'vite.docs-renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};

export default config;
