import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import path from 'node:path';
import fs from 'node:fs';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/node_modules/{node-pty,ssh2}/**',
    },
    extraResource: [],
  },
  rebuildConfig: {
    // Skip native module rebuild during dev — prebuilt N-API binaries work.
    // VS 2025 (v18) is not yet recognized by @electron/node-gyp.
    onlyModules: [],
  },
  hooks: {
    // Copy native module node_modules into the packaged app before ASAR creation
    packageAfterCopy: async (_config, buildPath) => {
      const nodeModulesPath = path.join(buildPath, 'node_modules');

      // Ensure node_modules dir exists in the build
      if (!fs.existsSync(nodeModulesPath)) {
        fs.mkdirSync(nodeModulesPath, { recursive: true });
      }

      // Copy native modules that Vite marks as external
      const externalModules = ['node-pty', 'ssh2'];
      const srcModules = path.resolve(__dirname, 'node_modules');

      for (const mod of externalModules) {
        const src = path.join(srcModules, mod);
        const dest = path.join(nodeModulesPath, mod);
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      }

      // Also copy transitive native deps (bindings, node-addon-api, etc.)
      const transitiveDeps = ['bindings', 'node-addon-api', 'file-uri-to-path',
        'cpu-features', 'nan', 'prebuild-install', 'detect-libc'];
      for (const mod of transitiveDeps) {
        const src = path.join(srcModules, mod);
        const dest = path.join(nodeModulesPath, mod);
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      }
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
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
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
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
