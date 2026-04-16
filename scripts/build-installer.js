import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const channel = process.argv[2] || "stable";
const supportedChannels = new Set(["stable", "canary"]);
const projectRoot = process.cwd();
const buildRoot = join(projectRoot, "build");
const artifactsRoot = join(projectRoot, "artifacts");
const buildFolderPrefix = `${channel}-win-`;
const electrobunBinary = resolve(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electrobun.exe" : "electrobun",
);
const buildStartedAt = Date.now();

function sanitizeZipStem(stem) {
  return stem.replace(/ /g, "");
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getPowerShellBinary() {
  return Bun.which("pwsh") || Bun.which("powershell") || "";
}

async function runCommand(cmd) {
  const proc = Bun.spawn({
    cmd,
    stdout: "inherit",
    stderr: "inherit",
  });

  return proc.exited;
}

async function clearStaleOutputs() {
  if (existsSync(buildRoot)) {
    const buildEntries = await readdir(buildRoot, { withFileTypes: true });

    for (const entry of buildEntries) {
      if (entry.name.startsWith(buildFolderPrefix)) {
        await rm(join(buildRoot, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  if (existsSync(artifactsRoot)) {
    const artifactEntries = await readdir(artifactsRoot, {
      withFileTypes: true,
    });

    for (const entry of artifactEntries) {
      if (entry.name.startsWith(buildFolderPrefix)) {
        await rm(join(artifactsRoot, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

async function findBuildFolder() {
  if (!existsSync(buildRoot)) {
    return null;
  }

  const entries = await readdir(buildRoot, { withFileTypes: true });
  const matchingFolder = entries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith(buildFolderPrefix),
  );

  return matchingFolder ? join(buildRoot, matchingFolder.name) : null;
}

async function getInstallerFileSet(buildFolder, minimumMtimeMs) {
  const entries = await readdir(buildFolder);
  const metadataFile = entries.find((entry) =>
    entry.endsWith(".metadata.json"),
  );

  if (!metadataFile) {
    return null;
  }

  const stem = metadataFile.slice(0, -".metadata.json".length);
  const exePath = join(buildFolder, `${stem}.exe`);
  const archivePath = join(buildFolder, `${stem}.tar.zst`);
  const metadataPath = join(buildFolder, metadataFile);

  if (
    !existsSync(exePath) ||
    !existsSync(archivePath) ||
    !existsSync(metadataPath)
  ) {
    return null;
  }

  const fileStats = await Promise.all([
    stat(exePath),
    stat(archivePath),
    stat(metadataPath),
  ]);

  if (fileStats.some((fileStat) => fileStat.mtimeMs < minimumMtimeMs)) {
    return null;
  }

  return {
    stem,
    exePath,
    archivePath,
    metadataPath,
    zipPath: join(buildFolder, `${sanitizeZipStem(stem)}.zip`),
  };
}

async function createInstallerZip(fileSet, powerShell) {
  if (!powerShell) {
    throw new Error(
      "PowerShell is required to build the Windows installer package.",
    );
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), "tts-desktop-installer-"));
  const stagingInstallerDir = join(stagingRoot, ".installer");
  const zipScriptPath = join(stagingRoot, "zip-installer.ps1");

  try {
    await mkdir(stagingInstallerDir, { recursive: true });
    await copyFile(
      fileSet.exePath,
      join(stagingRoot, basename(fileSet.exePath)),
    );
    await copyFile(
      fileSet.metadataPath,
      join(stagingInstallerDir, basename(fileSet.metadataPath)),
    );
    await copyFile(
      fileSet.archivePath,
      join(stagingInstallerDir, basename(fileSet.archivePath)),
    );

    const zipScript = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `$Source = ${quotePowerShell(stagingRoot)}`,
      `$Destination = ${quotePowerShell(fileSet.zipPath)}`,
      "if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }",
      "$zip = [System.IO.Compression.ZipFile]::Open($Destination, [System.IO.Compression.ZipArchiveMode]::Create)",
      "try {",
      "  Get-ChildItem -LiteralPath $Source -Recurse -File | ForEach-Object {",
      "    $relative = [System.IO.Path]::GetRelativePath($Source, $_.FullName)",
      "    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null",
      "  }",
      "} finally {",
      "  $zip.Dispose()",
      "}",
    ].join("\r\n");

    await writeFile(zipScriptPath, zipScript, "utf8");

    const exitCode = await runCommand([
      powerShell,
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      zipScriptPath,
    ]);

    if (exitCode !== 0 || !existsSync(fileSet.zipPath)) {
      throw new Error("Failed to create the Windows installer zip package.");
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function writeUpdateJson(buildFolderName, metadataPath) {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const packageJson = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  const updateJsonPath = join(artifactsRoot, `${buildFolderName}-update.json`);

  await writeFile(
    updateJsonPath,
    JSON.stringify(
      {
        version: packageJson.version,
        hash: metadata.hash,
        platform: "win",
        arch: process.arch,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function publishArtifacts(buildFolder, fileSet) {
  const buildFolderName = basename(buildFolder);

  await mkdir(artifactsRoot, { recursive: true });
  await writeUpdateJson(buildFolderName, fileSet.metadataPath);

  const filesToCopy = [
    fileSet.exePath,
    fileSet.archivePath,
    fileSet.metadataPath,
    fileSet.zipPath,
  ];

  for (const filePath of filesToCopy) {
    const destination = join(
      artifactsRoot,
      `${buildFolderName}-${basename(filePath)}`,
    );
    await copyFile(filePath, destination);
  }
}

async function finalizeInstallerArtifacts(powerShell, minimumMtimeMs) {
  const buildFolder = await findBuildFolder();
  if (!buildFolder) {
    return false;
  }

  const fileSet = await getInstallerFileSet(buildFolder, minimumMtimeMs);
  if (!fileSet) {
    return false;
  }

  if (!existsSync(fileSet.zipPath)) {
    await createInstallerZip(fileSet, powerShell);
  }

  await publishArtifacts(buildFolder, fileSet);
  console.log(`Published installer artifacts to ${artifactsRoot}`);
  return true;
}

function validateBuildInputs(powerShell) {
  if (!supportedChannels.has(channel)) {
    throw new Error(
      `Unsupported build channel '${channel}'. Use one of: ${[...supportedChannels].join(", ")}.`,
    );
  }

  if (process.platform !== "win32") {
    throw new Error(
      "scripts/build-installer.js currently supports Windows packaging only.",
    );
  }

  if (!existsSync(electrobunBinary)) {
    throw new Error(`Electrobun binary not found at ${electrobunBinary}`);
  }

  if (!powerShell) {
    throw new Error(
      "PowerShell is required to build and package Windows installer artifacts. Install pwsh or Windows PowerShell and ensure it is on PATH.",
    );
  }
}

const powerShell = getPowerShellBinary();

validateBuildInputs(powerShell);
await clearStaleOutputs();

const exitCode = await runCommand([
  electrobunBinary,
  "build",
  `--env=${channel}`,
]);
const finalized = await finalizeInstallerArtifacts(powerShell, buildStartedAt);

if (exitCode !== 0) {
  if (finalized) {
    console.warn(
      "Electrobun returned a non-zero exit code, but fresh installer artifacts were produced and published.",
    );
    process.exit(0);
  }

  process.exit(exitCode);
}

if (!finalized) {
  console.error(
    "Electrobun build completed, but no fresh installer artifacts were produced.",
  );
  process.exit(1);
}

process.exit(0);
